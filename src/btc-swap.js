const bitcoin = require('bitcoinjs-lib')
const bip65 = require('bip65')
const rng = require('randombytes')
const types = require('./types')

const hashType = bitcoin.Transaction.SIGHASH_ALL
const ANY_CHUNK = Buffer.alloc(0)

function utcNow () {
    return Math.floor(Date.now() / 1000)
}

const settings = {
    network: bitcoin.networks.bitcoin,
    secretSize: 32,
    client: null
};

/**
 *
 * @returns {Contract} Generated contract
 */
function initiate (partyAPublicKey, partyBPublicKey) {
    const lockTime = bip65.encode({ utc: utcNow() + (3600 * 24) })
    const secret = rng(settings.secretSize)
    const secretHash = bitcoin.crypto.sha256(secret)
    const redeemScript = atomicSwapContract(partyAPublicKey, partyBPublicKey, lockTime, secretHash)
    const { address, hash } = bitcoin.payments.p2sh({ redeem: { output: redeemScript, network: settings.network }, network: settings.network })

    return new types.Contract(hash, address, redeemScript, secret, secretHash.toString('hex'))
}

async function audit(address, contractScript, partyBPubKey, amount = null) {
    const scriptHash = Buffer.from(bitcoin.crypto.hash160(contractScript)).toString('hex');
    const unspents = await settings.client.unspents(address)
    //check amount
    let sum = 0.0
    for (const unspent of unspents) {
        // check script hash
        if (unspent.scriptPubKey.substring(4, unspent.scriptPubKey.length - 2) !== scriptHash) {
            throw new Error(`Incorrect script hash, should be: ${scriptHash}`)
        }
        sum += unspent.amount
    }
    //check amount
    if (amount && sum < amount) {
        throw new Error(`Incorrect address balance: ${sum}, should be: ${amount}`)
    }

    const asm = bitcoin.script.toASM(contractScript)
    const chunks = bitcoin.script.decompile(contractScript)
    console.log(ANY_CHUNK)
    const reqChunks = getContractChunks(ANY_CHUNK, partyBPubKey, ANY_CHUNK, ANY_CHUNK)
    for (let i = 0; i < chunks.length; i++) {
        if (reqChunks[i] !== ANY_CHUNK) {
            if (Buffer.isBuffer(chunks[i]) && !chunks[i].equals(reqChunks[i])) {
                throw new Error(`Incorrect ${i} chunk: required = ${reqChunks[i]}, found = ${chunks[i]}`)
            }
        }
    }
    // Check locktime
    if (chunks[11] < utcNow() + 3600) {
        throw new Error(`Locktime: ${chunks[11]} is too early`)
    }
    return chunks[5].toString('hex')
}

/**
 * @param contract: Contract
 * @param toAddress: String
 * @param partyBPair: ECPair
 */
async function redeem (contract, toAddress, partyBPair) {
    const txb = new bitcoin.TransactionBuilder(settings.network)
    // txb.setLockTime(lockTime)
    // Note: nSequence MUST be <= 0xfffffffe otherwise LockTime is ignored, and is immediately spendable.
    const unspents = await settings.client.unspents(contract.address)
    let sum = 0.0
    unspents.forEach(u => {
        txb.addInput(u.txid, u.vout)
        sum += u.amount
    })
    sum = Math.round(sum * 1e8)

    const fee = await settings.client.calcFee({'P2SH-P2WPKH': unspents.length}, {'P2PKH': 1})
    txb.addOutput(toAddress, sum - fee)

    // <Mir sig> <Mir pubkey> <client secret> OP_TRUE
    const tx = txb.buildIncomplete()
    for (let i = 0; i < unspents.length; i++) {
        const signatureHash = tx.hashForSignature(i, contract.script, hashType)
        const redeemScriptSig = bitcoin.payments.p2sh({
            redeem: {
                input: bitcoin.script.compile([
                    bitcoin.script.signature.encode(partyBPair.sign(signatureHash), hashType),
                    partyBPair.publicKey,
                    contract.secret,
                    bitcoin.opcodes.OP_TRUE
                ]),
                output: contract.script
            }
        }).input
        tx.setInputScript(i, redeemScriptSig)
    }

    console.log(`Virtual size = ${tx.virtualSize()}`)
    return tx
}

function refund () {}

function getContractChunks (clientPkh, mirPkh, lockTime, secretHash) {
    return [
        bitcoin.opcodes.OP_IF,

        bitcoin.opcodes.OP_SIZE,
        bitcoin.script.number.encode(settings.secretSize),
        bitcoin.opcodes.OP_EQUALVERIFY,

        // Require initiator's secret to be known to redeem the output.
        bitcoin.opcodes.OP_SHA256,
        secretHash !== ANY_CHUNK ? secretHash : ANY_CHUNK,
        bitcoin.opcodes.OP_EQUALVERIFY,

        // Verify mir signature is being used to redeem the output
        bitcoin.opcodes.OP_DUP,
        bitcoin.opcodes.OP_HASH160,
        mirPkh !== ANY_CHUNK ? bitcoin.crypto.hash160(mirPkh) : ANY_CHUNK,

        // Refund path
        bitcoin.opcodes.OP_ELSE,
        // Verify locktime and drop it off the stack (which is not done by CLTV)
        lockTime !== ANY_CHUNK ? bitcoin.script.number.encode(lockTime) : ANY_CHUNK,
        bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
        bitcoin.opcodes.OP_DROP,

        // Verify client signature is being used to redeem the output.
        bitcoin.opcodes.OP_DUP,
        bitcoin.opcodes.OP_HASH160,
        clientPkh !== ANY_CHUNK ? bitcoin.crypto.hash160(clientPkh) : ANY_CHUNK,
        bitcoin.opcodes.OP_ENDIF,

        bitcoin.opcodes.OP_EQUALVERIFY,
        bitcoin.opcodes.OP_CHECKSIG
    ]
}

function atomicSwapContract (clientPkh, mirPkh, lockTime, secretHash) {
    return bitcoin.script.compile(getContractChunks(clientPkh, mirPkh, lockTime, secretHash))
}

module.exports = { settings, initiate, audit, redeem  };
