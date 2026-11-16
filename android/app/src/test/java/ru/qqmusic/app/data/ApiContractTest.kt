package ru.qqmusic.app.data

import kotlinx.coroutines.runBlocking
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ApiContractTest {
    @Test fun rejectUnsafeServerAddresses() {
        listOf("http://qqmusic.ru", "https://user:pass@qqmusic.ru", "https://qqmusic.ru/api", "https://qqmusic.ru/?a=1").forEach {
            assertThrows(IllegalArgumentException::class.java) { ServerAddress.parse(it) }
        }
        assertEquals("https://qqmusic.ru/", ServerAddress.parse(" https://qqmusic.ru ").toString())
    }
    @Test fun libraryTracksWaitForIndexingAndIgnoreUnknownFields() {
        val result = TrackJson.library(JSONObject("""{"tracks":[{"id":1,"nd_song_id":"abc","title":"Трек","artist":"Группа","duration_s":123,"future":42},{"id":2,"nd_song_id":null,"title":"Ещё индексируется","artist":"Группа"}],"next_offset":null}"""))
        assertEquals("nd:abc", result.tracks[0].ref)
        assertTrue(result.tracks[0].playable)
        assertFalse(result.tracks[1].playable)
        assertNull(result.next)
    }
    @Test fun likeBodyMatchesServerAndSessionFailureIsRecognized() = runBlocking {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        MockWebServer().use { server ->
            server.useHttps(serverTls.sslSocketFactory(), false)
            server.start()
            val builder = OkHttpClient.Builder().sslSocketFactory(clientTls.sslSocketFactory(), clientTls.trustManager)
            val api = QqMusicApi(server.url("/").newBuilder().host("localhost").build().toString(), CookieJar.NO_COOKIES, builder)
            server.enqueue(MockResponse().setBody("{\"ok\":true}"))
            api.setLiked("nd:song-id", true)
            val request = server.takeRequest()
            assertEquals("/api/star", request.path)
            val body = JSONObject(request.body.readUtf8())
            assertEquals("song-id", body.getJSONArray("song_ids").getString(0))
            assertFalse(body.getBoolean("unstar"))
            assertEquals("android", body.getString("client"))
            assertTrue(body.getString("event_id").isNotBlank())
            assertNull(request.getHeader("Origin"))
            server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
            try { api.me(); fail("401 must fail") } catch (error: ApiException) { assertEquals(401, error.status) }
        }
    }
    @Test fun streamReferenceIsEncodedAndFullTrackRequired() {
        val api = QqMusicApi("https://qqmusic.ru", CookieJar.NO_COOKIES)
        val uri = api.streamUrl("nd:a&other=x").toHttpUrl()
        assertEquals("nd:a&other=x", uri.queryParameter("ref"))
        assertEquals("1", uri.queryParameter("full"))
    }
    @Test fun catalogLinkedOwnedTrackUsesNavidromeIdentity() {
        val tracks = TrackJson.songs(org.json.JSONArray("""[{"ref":"dz:12","nd_song_id":"local12","title":"Owned","artist":"A"}]"""))
        assertEquals("nd:local12", tracks.single().ref)
        assertTrue(tracks.single().playable)
    }
    @Test fun artworkNeverLeavesAuthenticatedOrigin() {
        val api = QqMusicApi("https://qqmusic.ru", CookieJar.NO_COOKIES)
        assertEquals("https://qqmusic.ru/api/nd/cover/1", api.coverUrl("/api/nd/cover/1"))
        assertNull(api.coverUrl("https://other.ru/cover"))
        assertNull(api.coverUrl("http://qqmusic.ru/cover"))
    }
}
