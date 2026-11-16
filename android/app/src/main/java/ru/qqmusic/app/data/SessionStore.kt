package ru.qqmusic.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import org.json.JSONArray
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Only encrypted session cookies are persisted. Account passwords never enter this store. */
interface CookiePersistence {
    val server: String
    fun read(): List<Cookie>
    fun save(origin: String, cookies: List<Cookie>)
    fun clear()
}

class SessionStore(context: Context) : CookiePersistence {
    private val prefs = context.getSharedPreferences("qqmusic.session", Context.MODE_PRIVATE)
    override var server: String
        get() = prefs.getString("server", "https://qqmusic.ru")!!
        private set(value) { prefs.edit().putString("server", value).commit() }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("qqmusic.session.v1", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("qqmusic.session.v1",
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    @Synchronized override fun read(): List<Cookie> = try {
        val raw = prefs.getString("cookies", null)
        if (raw == null) emptyList() else {
            val bytes = Base64.decode(raw, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            val rows = JSONArray(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
            val origin = ServerAddress.parse(server)
            (0 until rows.length()).mapNotNull { Cookie.parse(origin, rows.getString(it)) }
        }
    } catch (_: Exception) { clear(); emptyList() }

    @Synchronized override fun save(origin: String, cookies: List<Cookie>) {
        if (cookies.isEmpty()) { clear(); server = origin; return }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val json = JSONArray(cookies.map { it.toString() }).toString().toByteArray(Charsets.UTF_8)
        val encoded = Base64.encodeToString(cipher.iv + cipher.doFinal(json), Base64.NO_WRAP)
        prefs.edit().putString("server", origin).putString("cookies", encoded).commit()
    }
    @Synchronized override fun clear() { prefs.edit().remove("cookies").commit() }
}

class SessionCookies(private val store: CookiePersistence, private val origin: HttpUrl) : CookieJar {
    private var cookies = if (ServerAddress.sameOrigin(ServerAddress.parse(store.server), origin)) store.read() else emptyList()
    @Synchronized override fun saveFromResponse(url: HttpUrl, incoming: List<Cookie>) {
        if (!ServerAddress.sameOrigin(origin, url)) return
        val sessions = incoming.filter { it.name in setOf("qqmusic_session", "hm_session") && it.matches(origin) }
        val names = incoming.map { it.name }.toSet()
        cookies = (cookies.filterNot { it.name in names } + sessions).filter { it.expiresAt > System.currentTimeMillis() }
        store.save(origin.toString().trimEnd('/'), cookies)
    }
    @Synchronized override fun loadForRequest(url: HttpUrl): List<Cookie> =
        if (!ServerAddress.sameOrigin(origin, url)) emptyList()
        else cookies.filter { it.expiresAt > System.currentTimeMillis() && it.matches(url) }
    @Synchronized fun clear() { cookies = emptyList(); store.clear() }
}
