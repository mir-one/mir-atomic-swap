const { describe, it } = require('mocha')
const assert = require('assert')
const crypto = require('crypto')
const mir = require('../')
const bitcoin = require('bitcoinjs-lib')
const regtestUtils = require('./_regtest')
const { transfer, order, broadcast, setScript, addressBalance, waitForTx } = require('@waves/waves-transactions')
const wc = require('@waves/waves-crypto')
const axios = require('axios');

describe('Mir Waves-BTC Atomic Swap', function () {
    mir.btcSwap.settings.network = regtestUtils.network
    mir.btcSwap.settings.client = {unspents: regtestUtils.unspents, calcFee: regtestUtils.calcFee, getBalance: regtestUtils.getBalance}

    mir.wavesSwap.settings.network = 'T'
    mir.wavesSwap.settings.nodeUrl = 'https://pool.testnet.wavesnodes.com'
    mir.wavesSwap.settings.assetId = 'EBJDs3MRUiK35xbj59ejsf5Z4wH9oz6FuHvSCHVQqZHS'

    const mirPair = bitcoin.ECPair.fromWIF('cScfkGjbzzoeewVWmU2hYPUHeVGJRDdFt7WhmrVVGkxpmPP8BHWe', mir.btcSwap.settings.network)
    const clientPair = bitcoin.ECPair.fromWIF('cMkopUXKWsEzAjfa1zApksGRwjVpJRB3831qM9W4gKZsLwjHXA9x', mir.btcSwap.settings.network)

    const btcMirAddress = regtestUtils.getAddress(mirPair)
    const btcClientAddress = regtestUtils.getAddress(clientPair)

    const http = axios.create({
        baseURL: mir.wavesSwap.settings.nodeUrl
    });

    const faucetSeed = "faucet"
    const wavesMirAddress = wc.address('mir', mir.wavesSwap.settings.network)
    const wavesClientAddress = wc.address('client', mir.wavesSwap.settings.network)

    it('Btc to Waves atomic swap', async function () {
        this.timeout(100000);

        // 1. Client initiate swap and create Contract address
        const contract = mir.btcSwap.initiate(clientPair.publicKey, mirPair.publicKey)

        // 2. Client pays 0.5 BTC to that Contract address
        const unspent = await regtestUtils.faucet(contract.address, 5e6)

        // 3. Client submit Contract and his Wave address to Mir for auditing, Mir retrieves balance and extracts Secret Hash
        const balance = await mir.btcSwap.settings.client.getBalance(contract.address, unspent.timestamp)
        const secretHash = (await mir.btcSwap.audit(contract.address, contract.script, mirPair.publicKey)).toString('hex')
        assert.strictEqual(secretHash, contract.secretHash)

        // 4. Mir initiate his swap side on Waves blockchain
        const wavesContract = await mir.wavesSwap.initiate(wavesMirAddress, wavesClientAddress, faucetSeed, secretHash)
        console.log(`Waves Smart contract: ${JSON.stringify(wavesContract)}`)
        assert.strictEqual(wavesContract.secretHash, secretHash)

        // 5. Mir pays 0.5 Mir BTC (OBTC) to Waves Smart account
        await mir.wavesSwap.payToAddress(wavesContract.address, 5e6, faucetSeed)

        // 6. Mir sends Waves Smart account, which can be unlock with Secret, to Client for auditing
        const wavesSecretHash = await mir.wavesSwap.auditAccount(wavesContract.address, wavesClientAddress, 5000000)
        // Both Secret Hashes should be equal
        assert.strictEqual(secretHash, wavesSecretHash)

        // 7. Client redeem 0.5 OBTC  from Waves Smart account revealing the Secret
        const wavesRedeemTx = await mir.wavesSwap.redeem(wavesContract.publicKey, wavesClientAddress, contract.secret)

        // 8. Mir uses secret from WavesRedeemTx to redeem 0.5 btc on Bitcoin blockchain
        const watchedTx = await mir.wavesSwap.watchRedeemTx(wavesContract.address)
        const secretFromTx = Buffer.from(wc.base58decode(watchedTx.proofs[0]))
        const reedemBtcContract = new mir.types.Contract(null, contract.address, contract.script, secretFromTx)
        const btcRedeemTx = await mir.btcSwap.redeem(reedemBtcContract, btcMirAddress, mirPair)
        assert.strictEqual(btcRedeemTx.outs[0].value > (0.05 - 0.001)*1e8, true)

        await regtestUtils.broadcast(btcRedeemTx.toHex())

        await regtestUtils.verify({
            txId: btcRedeemTx.getId(),
            address: btcMirAddress,
            vout: 0,
            value: btcRedeemTx.outs[0].value
        })
    })
})
