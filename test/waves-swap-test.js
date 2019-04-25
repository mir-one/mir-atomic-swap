const assert = require('assert')
const axios = require('axios');
const { from } = require('rxjs/observable/from');
require('axios-debug-log')
const { transfer, order, broadcast, setScript, addressBalance, waitForTx } = require('@waves/waves-transactions')
const wc = require('@waves/waves-crypto')
const { Subject, ReplaySubject, interval, of } = require('rxjs');
const { map, filter, takeWhile, switchMap, catchError, repeat, flatMap, delay, tap } = require('rxjs/operators');
const rng = require('randombytes')
const compiler = require('@waves/ride-js');
const crypto = require('crypto')
const mir = require('../')
const chai = require('chai')
const expect = chai.expect
chai.use(require('chai-as-promised'))
chai.should();

describe('Waves Atomic Swap', function () {
    const http = axios.create({
        baseURL: mir.wavesSwap.settings.nodeUrl
    });

    mir.wavesSwap.settings.network = 'Q'
    mir.wavesSwap.settings.nodeUrl = 'https://node.mir.dei.su'

    const faucetSeed = "faucet"
    const mirAddress = wc.address('mir', mir.wavesSwap.settings.network)
    const clientAddress = wc.address('client', mir.wavesSwap.settings.network)

    it('can initiate smart account', async function () {
        this.timeout(60000);
        const contract = await mir.wavesSwap.initiate(clientAddress, mirAddress, faucetSeed)
        console.log(`Smart contract: ${JSON.stringify(contract)}`)
        assert.strictEqual(contract.secret.length, mir.wavesSwap.settings.secretSize)
    })


    it('can redeem funds', async function () {
        this.timeout(60000);

        const contract = await mir.wavesSwap.initiate(clientAddress, mirAddress, faucetSeed)
        console.log(`Smart contract: ${JSON.stringify(contract)}`)

        await mir.wavesSwap.payToAddress(contract.address, 1e7, faucetSeed)

        const redeemTx = await mir.wavesSwap.redeem(contract.publicKey, mirAddress, contract.secret)

        return waitForTx(redeemTx.id, 60000, mir.wavesSwap.settings.nodeUrl)
    })

    it('can audit script', async function() {
        this.timeout(60000);
        const contract = await mir.wavesSwap.initiate(clientAddress, mirAddress, faucetSeed)
        console.log(`Smart contract: ${JSON.stringify(contract)}`)
        const secretHash = await mir.wavesSwap.auditAccount(contract.address, mirAddress)
        assert.strictEqual(secretHash, contract.secretHash)
    })

    it('can audit smart acccount with balance', async function() {
        this.timeout(60000);
        const contract = await mir.wavesSwap.initiate(clientAddress, mirAddress, faucetSeed)
        console.log(`Smart contract: ${JSON.stringify(contract)}`)

        mir.wavesSwap.settings.assetId = 'EBJDs3MRUiK35xbj59ejsf5Z4wH9oz6FuHvSCHVQqZHS'

        await mir.wavesSwap.payToAddress(contract.address, 1e4, faucetSeed)
        mir.wavesSwap.auditAccount(contract.address, mirAddress, 2e4).should.be.rejected

        const secretHash = await mir.wavesSwap.auditAccount(contract.address, mirAddress, 1e4)
        assert.strictEqual(secretHash, contract.secretHash)

        mir.wavesSwap.settings.assetId = undefined
    })

    it('test watchTx', async function() {
        this.timeout(60000);
        const someAmount = 4e5
        await mir.wavesSwap.payToAddress(clientAddress, someAmount, faucetSeed)
        await mir.wavesSwap.payToAddress( wc.address(faucetSeed, mir.wavesSwap.settings.network), someAmount, 'client', true)
        const tx = await mir.wavesSwap.watchRedeemTx(clientAddress)
        assert.strictEqual(tx.amount,  someAmount)
    })

})
