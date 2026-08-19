package com.company.callcenter.data.offline

import android.content.Context
import com.company.callcenter.security.SecureValueStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.min

class OfflineAccessStore(
    context: Context,
    private val clock: () -> Long = System::currentTimeMillis,
    private val passwordHasher: OfflinePasswordHasher = OfflinePasswordHasher(),
) {
    private val secure = SecureValueStore(context)
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    val isConfigured: Boolean
        get() = loadPasswordRecord() != null

    var maximumAttempts: Int
        get() = preferences.getInt(MAX_ATTEMPTS_KEY, DEFAULT_MAX_ATTEMPTS)
            .coerceIn(MIN_MAX_ATTEMPTS, MAX_MAX_ATTEMPTS)
        set(value) {
            require(value in MIN_MAX_ATTEMPTS..MAX_MAX_ATTEMPTS)
            preferences.edit().putInt(MAX_ATTEMPTS_KEY, value).apply()
        }

    fun createPassword(password: String) {
        check(!isConfigured) { "离线密码已经设置" }
        savePasswordRecord(passwordHasher.create(password))
        resetFailures()
        phoneHashKey()
    }

    fun verifyPassword(password: String): OfflineUnlockResult {
        val now = clock()
        val lockedUntil = preferences.getLong(LOCKED_UNTIL_KEY, 0L)
        if (lockedUntil > now) {
            return OfflineUnlockResult(
                unlocked = false,
                retryAfterSeconds = ((lockedUntil - now) + 999L) / 1_000L,
            )
        }
        val record = loadPasswordRecord() ?: return OfflineUnlockResult(unlocked = false)
        if (passwordHasher.verify(password, record)) {
            resetFailures()
            return OfflineUnlockResult(unlocked = true)
        }

        val failures = preferences.getInt(FAILED_ATTEMPTS_KEY, 0) + 1
        val delayMillis = lockDelayMillis(failures)
        preferences.edit()
            .putInt(FAILED_ATTEMPTS_KEY, failures)
            .putLong(LOCKED_UNTIL_KEY, now + delayMillis)
            .apply()
        return OfflineUnlockResult(
            unlocked = false,
            retryAfterSeconds = if (delayMillis == 0L) 0 else delayMillis / 1_000L,
        )
    }

    fun changePassword(currentPassword: String, newPassword: String): Boolean {
        val current = loadPasswordRecord() ?: return false
        if (!passwordHasher.verify(currentPassword, current)) return false
        savePasswordRecord(passwordHasher.create(newPassword))
        resetFailures()
        return true
    }

    fun clearPassword() {
        secure.put(PASSWORD_SALT_KEY, null)
        secure.put(PASSWORD_HASH_KEY, null)
        secure.put(PASSWORD_ITERATIONS_KEY, null)
        secure.put(PHONE_HASH_KEY, null)
        preferences.edit().clear().apply()
    }

    fun encrypt(value: String): String = secure.encrypt(value)

    fun decrypt(value: String): String = secure.decrypt(value)

    fun phoneHash(normalizedPhone: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(phoneHashKey(), "HmacSHA256"))
        return mac.doFinal(normalizedPhone.toByteArray(Charsets.UTF_8)).toHex()
    }

    private fun savePasswordRecord(record: OfflinePasswordRecord) {
        secure.put(PASSWORD_SALT_KEY, Base64.getEncoder().encodeToString(record.salt))
        secure.put(PASSWORD_HASH_KEY, Base64.getEncoder().encodeToString(record.hash))
        secure.put(PASSWORD_ITERATIONS_KEY, record.iterations.toString())
    }

    private fun loadPasswordRecord(): OfflinePasswordRecord? {
        val salt = secure.get(PASSWORD_SALT_KEY)?.let(::decodeBase64) ?: return null
        val hash = secure.get(PASSWORD_HASH_KEY)?.let(::decodeBase64) ?: return null
        val iterations = secure.get(PASSWORD_ITERATIONS_KEY)?.toIntOrNull() ?: return null
        if (salt.size != 16 || hash.size != 32) return null
        return OfflinePasswordRecord(salt, hash, iterations)
    }

    private fun phoneHashKey(): ByteArray {
        secure.get(PHONE_HASH_KEY)?.let(::decodeBase64)?.takeIf { it.size == HASH_KEY_BYTES }?.let {
            return it
        }
        val key = ByteArray(HASH_KEY_BYTES).also(SecureRandom()::nextBytes)
        secure.put(PHONE_HASH_KEY, Base64.getEncoder().encodeToString(key))
        return key
    }

    private fun decodeBase64(value: String): ByteArray? = runCatching {
        Base64.getDecoder().decode(value)
    }.getOrNull()

    private fun resetFailures() {
        preferences.edit()
            .remove(FAILED_ATTEMPTS_KEY)
            .remove(LOCKED_UNTIL_KEY)
            .apply()
    }

    private fun lockDelayMillis(failures: Int): Long {
        if (failures < FAILURES_BEFORE_DELAY) return 0L
        val exponent = min(failures - FAILURES_BEFORE_DELAY, 4)
        return min(BASE_LOCK_MILLIS shl exponent, MAX_LOCK_MILLIS)
    }

    private fun ByteArray.toHex(): String = joinToString("") { byte -> "%02x".format(byte) }

    private companion object {
        const val PREFERENCES_NAME = "offline_access"
        const val PASSWORD_SALT_KEY = "offline_password_salt"
        const val PASSWORD_HASH_KEY = "offline_password_hash"
        const val PASSWORD_ITERATIONS_KEY = "offline_password_iterations"
        const val PHONE_HASH_KEY = "offline_phone_hash_key"
        const val FAILED_ATTEMPTS_KEY = "failed_attempts"
        const val LOCKED_UNTIL_KEY = "locked_until"
        const val MAX_ATTEMPTS_KEY = "maximum_attempts"
        const val HASH_KEY_BYTES = 32
        const val FAILURES_BEFORE_DELAY = 5
        const val BASE_LOCK_MILLIS = 30_000L
        const val MAX_LOCK_MILLIS = 5 * 60_000L
        const val DEFAULT_MAX_ATTEMPTS = 2
        const val MIN_MAX_ATTEMPTS = 1
        const val MAX_MAX_ATTEMPTS = 10
    }
}
