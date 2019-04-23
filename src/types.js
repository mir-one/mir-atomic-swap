class Contract {
    constructor (publicKey, address, script, secret, secretHash) {
        this.publicKey = publicKey
        this.address = address
        this.script = script
        this.secret = secret
        this.secretHash = secretHash
    }
}

module.exports = { Contract }
