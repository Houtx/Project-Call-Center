package com.company.callcenter.data.offline

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

data class OfflinePasswordRecord(
    val salt: ByteArray,
    val hash: ByteArray,
    val iterations: Int,
)

class OfflinePasswordHasher(
    private val secureRandom: SecureRandom = SecureRandom(),
) {
    fun create(password: String): OfflinePasswordRecord {
        OfflinePasswordPolicy.requireValid(password)
        val salt = ByteArray(SALT_BYTES).also(secureRandom::nextBytes)
        return OfflinePasswordRecord(
            salt = salt,
            hash = derive(password, salt, ITERATIONS),
            iterations = ITERATIONS,
        )
    }

    fun verify(password: String, record: OfflinePasswordRecord): Boolean {
        if (password.length !in OfflinePasswordPolicy.MIN_LENGTH..OfflinePasswordPolicy.MAX_LENGTH) {
            return false
        }
        val candidate = derive(password, record.salt, record.iterations)
        return MessageDigest.isEqual(candidate, record.hash)
    }

    private fun derive(password: String, salt: ByteArray, iterations: Int): ByteArray {
        require(iterations in MIN_ITERATIONS..MAX_ITERATIONS) { "密码校验参数无效" }
        val specification = PBEKeySpec(password.toCharArray(), salt, iterations, HASH_BITS)
        return try {
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
                .generateSecret(specification)
                .encoded
        } finally {
            specification.clearPassword()
        }
    }

    private companion object {
        const val SALT_BYTES = 16
        const val HASH_BITS = 256
        const val ITERATIONS = 210_000
        const val MIN_ITERATIONS = 100_000
        const val MAX_ITERATIONS = 1_000_000
    }
}

object OfflinePasswordPolicy {
    const val MIN_LENGTH = 6
    const val MAX_LENGTH = 64

    fun requireValid(password: String) {
        require(password.length in MIN_LENGTH..MAX_LENGTH) {
            "离线密码需为 $MIN_LENGTH 至 $MAX_LENGTH 位"
        }
        require(password.any { !it.isWhitespace() }) { "离线密码不能全部为空格" }
    }
}
