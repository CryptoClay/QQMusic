package ru.qqmusic.app.data

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class SessionCookiesTest {
    private class MemoryStore : CookiePersistence {
        override var server = "https://qqmusic.ru"
        var saved = emptyList<Cookie>()
        override fun read() = saved
        override fun save(origin: String, cookies: List<Cookie>) { server = origin; saved = cookies }
        override fun clear() { saved = emptyList() }
    }
    private val origin = "https://qqmusic.ru/".toHttpUrl()
    @Test fun sessionNeverGoesToAnotherHostPortOrHttp() {
        val store = MemoryStore()
        val jar = SessionCookies(store, origin)
        jar.saveFromResponse(origin, listOf(Cookie.parse(origin, "qqmusic_session=secret; Path=/; Secure; HttpOnly; Max-Age=600")!!))
        assertEquals(1, jar.loadForRequest(origin.resolve("/api/auth/me")!!).size)
        listOf("https://other.ru/", "https://qqmusic.ru:444/", "http://qqmusic.ru/").forEach {
            assertTrue(jar.loadForRequest(it.toHttpUrl()).isEmpty())
        }
        assertEquals(1, SessionCookies(store, origin).loadForRequest(origin).size)
    }
    @Test fun expiredCookieAndLogoutCannotBeRestored() {
        val store = MemoryStore()
        val jar = SessionCookies(store, origin)
        jar.saveFromResponse(origin, listOf(Cookie.parse(origin, "qqmusic_session=secret; Path=/; Secure; Max-Age=600")!!))
        jar.saveFromResponse(origin, listOf(Cookie.parse(origin, "qqmusic_session=; Path=/; Secure; Max-Age=0")!!))
        assertTrue(jar.loadForRequest(origin).isEmpty())
        assertTrue(SessionCookies(store, origin).loadForRequest(origin).isEmpty())
    }
    @Test fun onlySessionCookiesFromSelectedServerArePersisted() {
        val store = MemoryStore()
        val jar = SessionCookies(store, origin)
        jar.saveFromResponse(origin, listOf(Cookie.parse(origin, "analytics=irrelevant; Path=/")!!))
        assertTrue(store.saved.isEmpty())
        val other = "https://other.ru/".toHttpUrl()
        jar.saveFromResponse(other, listOf(Cookie.parse(other, "qqmusic_session=wrong; Path=/; Secure")!!))
        assertTrue(store.saved.isEmpty())
    }
}
