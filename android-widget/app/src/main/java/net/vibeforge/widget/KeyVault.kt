package net.vibeforge.widget

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Seals the key each computer gave this widget when it paired. The sealing key is an AES key made
 * inside the Android Keystore: it never leaves it, so what lands in the app's own storage can't be
 * read back off the phone, from a backup or another app. A sealed key that can't be opened (the
 * Keystore was reset, the storage came from another phone) is treated as no key: pair again.
 */
object KeyVault {
    private const val STORE = "AndroidKeyStore"
    private const val ALIAS = "vibeforge-widget-keys"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val PREFIX = "v1:"

    private fun secret(): SecretKey {
        val keyStore = KeyStore.getInstance(STORE).apply { load(null) }
        (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun decode(text: String): ByteArray = Base64.decode(text, Base64.NO_WRAP)

    /** The key sealed for storage, or null when the Keystore refused (nothing is then kept). */
    fun seal(plain: String): String? = try {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, secret())
        val sealed = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        PREFIX + encode(cipher.iv) + ":" + encode(sealed)
    } catch (_: Exception) {
        null
    }

    /** The key, or null for one that can't be opened here. */
    fun open(stored: String): String? {
        if (!stored.startsWith(PREFIX)) return null
        val parts = stored.removePrefix(PREFIX).split(':')
        if (parts.size != 2) return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, decode(parts[0])))
            String(cipher.doFinal(decode(parts[1])), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }
}
