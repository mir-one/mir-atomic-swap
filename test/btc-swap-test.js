/* eslint no-unused-vars: 0 */

const { describe, it } = require('mocha')
const bitcoin = require('bitcoinjs-lib')
const regtestUtils = require('./_regtest')
const rng = require('randombytes')
const assert = require('assert')
const mir = require('../')
const chai = require('chai')
const expect = chai.expect
chai.use(require('chai-as-promised'))
chai.should();


function getAddress (keyPair) {
    return bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: mir.btcSwap.settings.network }).address
}

describe('Mir BTC Atomic Swap', function () {

    mir.btcSwap.settings.network = regtestUtils.network
    mir.btcSwap.settings.client = { unspents: regtestUtils.unspents, calcFee: regtestUtils.calcFee }

    const mirPair = bitcoin.ECPair.fromWIF('cScfkGjbzzoeewVWmU2hYPUHeVGJRDdFt7WhmrVVGkxpmPP8BHWe', mir.btcSwap.settings.network )
    const clientPair = bitcoin.ECPair.fromWIF('cMkopUXKWsEzAjfa1zApksGRwjVpJRB3831qM9W4gKZsLwjHXA9x', mir.btcSwap.settings.network )

    const mirAddress = regtestUtils.getAddress(mirPair)
    const clientAddress = regtestUtils.getAddress(clientPair)

    // expiry past, {Alice's signature} OP_TRUE
    it('Initiate transaction', function () {
        const contract = mir.btcSwap.initiate(clientPair.publicKey, mirPair.publicKey)
        assert.strictEqual(contract.secret.length, mir.btcSwap.settings.secretSize)
    })

    it('can redeem', async function () {
        this.timeout(60000);
        const contract = mir.btcSwap.initiate(clientPair.publicKey, mirPair.publicKey)
        const unspent = await regtestUtils.faucet(contract.address, 1e7)

        const toAddress = regtestUtils.RANDOM_ADDRESS
        console.log(`Redeem address: ${toAddress}`)

        const redeemTx = await mir.btcSwap.redeem(contract, toAddress, mirPair)

        await regtestUtils.broadcast(redeemTx.toHex())

        return regtestUtils.verify({
            txId: redeemTx.getId(),
            address: toAddress,
            vout: 0,
            value: redeemTx.outs[0].value
        })
    })

    it('can redeem 2 utxo', async function () {
        this.timeout(60000);
        const contract = mir.btcSwap.initiate(clientPair.publicKey, mirPair.publicKey)
        await regtestUtils.faucet(contract.address, 1e7)
        await regtestUtils.faucet(contract.address, 2e7)

        const toAddress = regtestUtils.RANDOM_ADDRESS
        console.log(`Redeem address: ${toAddress}`)

        const redeemTx = await mir.btcSwap.redeem(contract, toAddress, mirPair)

        try {
            await regtestUtils.broadcast(redeemTx.toHex())
        } catch (e) {
            throw new Error('Incorrect redeem transaction: ' + e)
        }

        return regtestUtils.verify({
            txId: redeemTx.getId(),
            address: toAddress,
            vout: 0,
            value: redeemTx.outs[0].value
        })
    })

    it('can audit script', async function () {
        this.timeout(60000);
        const contract = mir.btcSwap.initiate(clientPair.publicKey, mirPair.publicKey)
        assert.strictEqual(await mir.btcSwap.audit(contract.address, contract.script, mirPair.publicKey), contract.secretHash)
    })

    it('can audit script with balance', async function () {
        this.timeout(60000);
        const contract = mir.btcSwap.initiate(clientPair.publicKey, mirPair.publicKey)
        await regtestUtils.faucet(contract.address, 2e6)

        await mir.btcSwap.audit(contract.address, contract.script, mirPair.publicKey, 0.03).should.be
            .rejectedWith(Error, 'Incorrect address balance: 0.02, should be: 0.03')

        const hash = await mir.btcSwap.audit(contract.address, contract.script, mirPair.publicKey, 0.02)
        assert.strictEqual(hash, contract.secretHash)
    })

})
