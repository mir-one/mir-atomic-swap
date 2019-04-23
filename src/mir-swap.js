const axios = require('axios');
const { from } = require('rxjs/observable/from');
require('axios-debug-log')
const { transfer, order, broadcast, setScript, addressBalance, waitForTx } = require('@mir/mir-transactions')
const wc = require('@mir/mir-crypto')
const { Subject, ReplaySubject, interval, of } = require('rxjs');
const { map, filter, takeWhile, switchMap, catchError, repeat, flatMap, first, delay, tap } = require('rxjs/operators');
const rng = require('randombytes')
const compiler = require('@mir/ride-js');
const types = require('./types')

const settings = {
    nodeUrl: 'https://nodes.mir.one',
    assetId: undefined,
    defaultTransferFee: 500000,
    network: 'Q',
    secretSize: 32
};

http = () => axios.create({
    baseURL: settings.nodeUrl
})

async function initiate(partyA, partyB, feeSeed, secretHash = null) {
    const currentHeight = await getCurrentHeight()
    const unlockHeight = currentHeight + 1440

    //const secret = rng(settings.secretSize)
    let secret = null
    let base58SecretHash = null

    if (!secretHash) {
        secret = wc.randomUint8Array(settings.secretSize)
        const bufSecretHash = wc.sha256(secret)
        secretHash = Buffer.from(bufSecretHash).toString('hex')
        base58SecretHash = wc.base58encode(bufSecretHash);
    } else if (typeof secretHash == 'string' ) {
        base58SecretHash = wc.base58encode(Buffer.from(secretHash, 'hex'))
    }
    const script = atomicSwapScript(partyA, partyB, unlockHeight, base58SecretHash)

    const compiledScript = compiler.compile(script);

    const seed = await createSmartAddress(feeSeed)

    const tx = await setScriptAndBroadcast(compiledScript.result.base64, seed)

    await waitForTx(tx.id, 60000, settings.nodeUrl)

    return new types.Contract(wc.publicKey(seed), wc.address(seed, settings.network), script, secret, secretHash)
}

async function audit (contractScript, partyB) {
    const currentHeight = await getCurrentHeight()
    const pattern = /LET_BLOCK\(LET\(partyA,FUNCTION_CALL\(User\(Address\),List\(CONST_BYTESTR\((\w+)\)\)\)\),LET_BLOCK\(LET\(partyB,FUNCTION_CALL\(User\(Address\),List\(CONST_BYTESTR\((\w+)\)\)\)\),LET_BLOCK\(LET\(secretHash,CONST_BYTESTR\((\w+)\)\),LET_BLOCK\(LET\(unlockHeight,CONST_LONG\((\d+)\)\),LET_BLOCK\(LET\(\$match0,REF\(tx\)\),IF\(FUNCTION_CALL\(Native\(1\),List\(REF\(\$match0\), CONST_STRING\(TransferTransaction\)\)\),LET_BLOCK\(LET\(ttx,REF\(\$match0\)\),LET_BLOCK\(LET\(txToClient,IF\(IF\(FUNCTION_CALL\(Native\(0\),List\(GETTER\(REF\(ttx\),recipient\), REF\(partyB\)\)\),FUNCTION_CALL\(Native\(0\),List\(FUNCTION_CALL\(Native\(503\),List\(FUNCTION_CALL\(Native\(401\),List\(GETTER\(REF\(ttx\),proofs\), CONST_LONG\(0\)\)\)\)\), REF\(secretHash\)\)\),FALSE\),FUNCTION_CALL\(Native\(103\),List\(REF\(unlockHeight\), REF\(height\)\)\),FALSE\)\),LET_BLOCK\(LET\(refund,IF\(FUNCTION_CALL\(Native\(103\),List\(REF\(height\), REF\(unlockHeight\)\)\),FUNCTION_CALL\(Native\(0\),List\(GETTER\(REF\(ttx\),recipient\), REF\(partyA\)\)\),FALSE\)\),IF\(REF\(txToClient\),TRUE,REF\(refund\)\)\)\)\),LET_BLOCK\(LET\(other,REF\(\$match0\)\),FALSE\)\)\)\)\)\)\)/
    const res = contractScript.match(pattern)

    if (!res)
        throw new Error(`Incorrect script`)
    if (res[4] < currentHeight + 360) {
        throw new Error(`Locktime: ${res[4]} is too early`)
    }
    if (res[2] !== partyB) {
        throw new Error(`Incorrect PartyB: ${res[2]}`)
    }

    return res[3]
}

async function auditAccount(address, partyB, amount = null) {
    const scriptText = await getScriptText(address)
    const secretHash = await audit(scriptText, partyB)
    if (amount) {
        const bal = await getBalance(address)
        if (bal < amount) {
            throw new Error(`Incorrect account balance: ${bal}, should be: ${amount}`)
        }
    }

    return Buffer.from(wc.base58decode(secretHash)).toString('hex')
}

/**
 * @param contractPubKey: String
 * @param toAddress: String
 * @param secret: String
 */
async function redeem (contractPubKey, toAddress, secret) {
    const address = wc.address({public: contractPubKey}, settings.network)
    const balance = await getBalance(address)

    const unsignedTransferTx = transfer({
        amount: Math.round(settings.assetId ? balance : balance - settings.defaultTransferFee),
        assetId: settings.assetId,
        recipient: toAddress,
        senderPublicKey: contractPubKey,
        fee: settings.defaultTransferFee,
    })
    unsignedTransferTx.proofs[0] = wc.base58encode(secret)

    return broadcast(unsignedTransferTx, settings.nodeUrl)
}

function refund () {}

function getContractChunks (clientPkh, mirPkh, lockTime, secretHash) {

}

async function getCurrentHeight() {
    return http().get(`/blocks/height`).then(res => {
        return res.data.height;
    });
}

async function decompiledScript(txId) {
    const script = (await http().get(`transactions/info/${txId}`)).data.script
    const res = await http().post(`utils/script/decompile`, script)
    if (res.data.CONTENT_TYPE !== 'EXPRESSION') {
        throw new Error(`Incorrect res.data.CONTENT_TYPE: ${res.data.CONTENT_TYPE }`)
    }
    return res.data.script
}

async function getScriptText(address) {
    return (await http().get(`addresses/scriptInfo/${address}`)).data.scriptText
}

async function getBalance(address, assetId = settings.assetId) {
    if (assetId) {
        return (await http().get(`assets/balance/${address}/${settings.assetId}`)).data.balance
    } else {
        return (await http().get(`addresses/balance/${address}`)).data.balance
    }
}

async function getLastTransactions(address) {
    return (await http().get(`transactions/address/${address}/limit/1`)).data[0][0]
}

async function waitForBalance(address, balance, assetId = null) {
    return interval(1000).pipe(
        flatMap(_ => from(getBalance(address, assetId))),
        takeWhile(b => b != balance)
    ).toPromise();
}

async function createSmartAddress(fromSeed) {
    const seed = wc.base58encode(wc.randomUint8Array(128));
    const address = wc.address(seed, settings.network);

    const amount = 1000000 + settings.defaultTransferFee
    const signedTx = transfer({
        amount: amount,
        recipient: address
    }, fromSeed);
    const resp = await broadcast(signedTx, settings.nodeUrl);

    await waitForBalance(address, amount)

    return seed
}

function atomicSwapScript (addressA, addressB, unlockHeight, secretHash) {
    const contract = `
let partyA = Address(base58'${addressA}')
let partyB = Address(base58'${addressB}')
let secretHash = base58'${secretHash}'
let unlockHeight = ${unlockHeight}

match tx {
case ttx: TransferTransaction =>
let txToClient = (ttx.recipient == partyB) && (sha256(ttx.proofs[0]) == secretHash) && (height <= unlockHeight)
let refund = ((height >= unlockHeight) && (ttx.recipient == partyA))
txToClient || refund
case other => false
}`;
    return contract;
}

async function setScriptAndBroadcast(script, seed) {
    const params = {
        script: script,
        chainId: settings.network
    };

    const setScriptTx = setScript(params, seed);

    return broadcast(setScriptTx, settings.nodeUrl);
}

async function payToAddress(toAddress, amount, seed, nowait = false) {
    const signedTx = transfer({
        amount: amount,
        assetId: settings.assetId,
        recipient: toAddress
    }, seed);

    const tx = await broadcast(signedTx, settings.nodeUrl)

    return nowait ? tx : waitForTx(tx.id, 60000, settings.nodeUrl)

}

async function watchRedeemTx(address) {
    return interval(1000).pipe(
        flatMap(_ => from(getLastTransactions(address))),
        first(tx => tx.type === 4 && tx.sender === address)
    ).toPromise();
}

module.exports = { settings, initiate, auditAccount, redeem, payToAddress, watchRedeemTx };
