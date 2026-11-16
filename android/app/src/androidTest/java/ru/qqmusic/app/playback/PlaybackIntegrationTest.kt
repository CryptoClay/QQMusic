package ru.qqmusic.app.playback

import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.session.MediaController
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.runner.RunWith
import ru.qqmusic.app.MainActivity
import ru.qqmusic.app.data.AppGraph
import ru.qqmusic.app.data.CookiePersistence
import ru.qqmusic.app.data.QqMusicApi
import ru.qqmusic.app.data.ServerAddress
import ru.qqmusic.app.data.SessionCookies
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/** Exercises the real controller → service → authenticated HTTPS → decoder/audio clock path. */
@RunWith(AndroidJUnit4::class)
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlaybackIntegrationTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private fun <T> main(block: () -> T): T {
        val task = FutureTask(block)
        instrumentation.runOnMainSync(task)
        return task.get(10, TimeUnit.SECONDS)
    }
    private fun eventually(description: String, block: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25)
        while (System.nanoTime() < deadline) {
            if (block()) return
            Thread.sleep(50)
        }
        fail(description)
    }
    private fun wave(): ByteArray {
        val frames = 8000 * 10
        val bytes = frames * 2
        return ByteBuffer.allocate(44 + bytes).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray()); putInt(36 + bytes); put("WAVEfmt ".toByteArray())
            putInt(16); putShort(1); putShort(1); putInt(8000); putInt(16000); putShort(2); putShort(16)
            put("data".toByteArray()); putInt(bytes)
            repeat(frames) { putShort((kotlin.math.sin(it * 2 * Math.PI * 440 / 8000) * 1000).toInt().toShort()) }
        }.array()
    }
    @Test fun ownAppControllerPlaysSeeksSkipsAndKeepsPlayingWithoutActivity() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val requests = CopyOnWriteArrayList<RecordedRequest>()
        val audio = wave()
        MockWebServer().use { server ->
            server.useHttps(serverTls.sslSocketFactory(), false)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests.add(request)
                    val path = request.path.orEmpty()
                    return when {
                        path.startsWith("/api/auth/me") -> MockResponse().setBody("{\"username\":\"Acceptance\"}")
                        path.startsWith("/api/starred") -> MockResponse().setBody("{\"song_ids\":[]}")
                        path.startsWith("/api/star") -> MockResponse().setBody("{\"ok\":true}")
                        path.startsWith("/api/search/library") -> MockResponse().setBody("""{"tracks":[{"id":1,"nd_song_id":"first","title":"Acceptance track 1","artist":"Fixture"},{"id":2,"nd_song_id":"second","title":"Acceptance track 2","artist":"Fixture"}],"next_offset":null}""")
                        path.startsWith("/api/listen/stream") -> {
                            val offset = request.getHeader("Range")?.substringAfter("bytes=")?.substringBefore('-')?.toIntOrNull() ?: 0
                            MockResponse().setResponseCode(if (offset == 0) 200 else 206)
                                .addHeader("Content-Type", "audio/wav").addHeader("Accept-Ranges", "bytes")
                                .apply { if (offset > 0) addHeader("Content-Range", "bytes $offset-${audio.lastIndex}/${audio.size}") }
                                .setBody(Buffer().write(audio, offset, audio.size - offset))
                        }
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
            server.start()
            val origin = server.url("/").newBuilder().host("localhost").build()
            val persistence = object : CookiePersistence {
                override val server = origin.toString()
                override fun read() = emptyList<Cookie>()
                override fun save(origin: String, cookies: List<Cookie>) {}
                override fun clear() {}
            }
            val jar = SessionCookies(persistence, origin)
            jar.saveFromResponse(origin, listOf(Cookie.parse(origin, "qqmusic_session=playback-fixture; Path=/; Secure; HttpOnly")!!))
            val api = QqMusicApi(origin.toString(), jar,
                OkHttpClient.Builder().sslSocketFactory(clientTls.sslSocketFactory(), clientTls.trustManager))
            val field = AppGraph::class.java.getDeclaredField("api").apply { isAccessible = true }
            val originalApi = AppGraph.api
            field.set(null, api)
            var controller: MediaController? = null
            var scenario: ActivityScenario<MainActivity>? = null
            try {
                scenario = ActivityScenario.launch(MainActivity::class.java)
                val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
                val future = main { MediaController.Builder(context, token).buildAsync() }
                val player = future.get(20, TimeUnit.SECONDS)
                controller = player
                if (android.os.Build.VERSION.SDK_INT >= 28) {
                    val manager = context.getSystemService(android.media.session.MediaSessionManager::class.java)
                    val identity = android.media.session.MediaSessionManager.RemoteUserInfo(context.packageName, android.os.Process.myPid(), android.os.Process.myUid())
                    println("own_controller_system_trust=${manager.isTrustedForMediaControl(identity)}")
                }
                compose.waitUntil(15000) { compose.onAllNodesWithText("Acceptance track 1").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("Acceptance track 1").performClick()
                eventually("Real audio did not advance: ${main { player.playerError?.errorCodeName }}") {
                    main { player.isPlaying && player.currentPosition > 250 }
                }
                main { player.seekTo(1500) }
                eventually("Seek failed") { main { player.currentPosition > 1600 } }
                main { player.seekToNextMediaItem() }
                eventually("Next track did not start") { main { player.currentMediaItem?.mediaId == "nd:second" && player.isPlaying && player.currentPosition > 100 } }
                val like = main { player.sendCustomCommand(PlaybackService.TOGGLE_LIKE, Bundle.EMPTY) }
                assertEquals(SessionResult.RESULT_SUCCESS, like.get(10, TimeUnit.SECONDS).resultCode)
                scenario.close(); scenario = null
                val position = main { player.currentPosition }
                eventually("Audio stopped when activity closed") { main { player.isPlaying && player.currentPosition > position + 250 } }
                val audioRequests = requests.filter { it.path.orEmpty().startsWith("/api/listen/stream") }
                assertTrue(audioRequests.size >= 2)
                assertTrue(audioRequests.all { it.getHeader("Cookie").orEmpty().contains("qqmusic_session=playback-fixture") })
                assertTrue(requests.any { it.path == "/api/star" })
            } finally {
                main { controller?.apply { stop(); clearMediaItems(); release() } }
                scenario?.close()
                context.stopService(Intent(context, PlaybackService::class.java))
                instrumentation.waitForIdleSync()
                field.set(null, originalApi)
            }
        }
    }
}
