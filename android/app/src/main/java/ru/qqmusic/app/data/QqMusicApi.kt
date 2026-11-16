package ru.qqmusic.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.CookieJar
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, message: String) : IOException(message)

class QqMusicApi(server: String, jar: CookieJar, builder: OkHttpClient.Builder = OkHttpClient.Builder()) {
    private val base = ServerAddress.parse(server)
    val origin = base.toString().trimEnd('/')
    val http: OkHttpClient = builder.cookieJar(jar).followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(90, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            if (!ServerAddress.sameOrigin(base, chain.request().url)) throw IOException("Недопустимый адрес запроса")
            chain.proceed(chain.request())
        }.build()

    private suspend fun request(path: String, json: JSONObject? = null): String = withContext(Dispatchers.IO) {
        val url = base.resolve(path) ?: throw IOException("Недопустимый адрес")
        val request = Request.Builder().url(url).header("Accept", "application/json").apply {
            if (json != null) post(json.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
        }.build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string() ?: "{}"
            if (!response.isSuccessful) {
                val detail = runCatching { JSONObject(text).optString("detail") }.getOrDefault("")
                throw ApiException(response.code, when {
                    response.code == 401 -> "Сессия истекла. Войди снова."
                    detail.isNotBlank() && detail.length < 500 -> detail
                    response.code == 429 -> "Слишком много запросов. Подожди немного."
                    else -> "Сервер вернул ошибку ${response.code}"
                })
            }
            text
        }
    }

    suspend fun login(username: String, password: String) =
        JSONObject(request("/api/auth/login", JSONObject().put("username", username).put("password", password))).getString("username")
    suspend fun me() = JSONObject(request("/api/auth/me")).getString("username")
    suspend fun logout() { request("/api/auth/logout", JSONObject()) }
    suspend fun library(query: String, offset: Int): TrackPage {
        val path = "$origin/api/search/library".toHttpUrl().newBuilder().addQueryParameter("q", query)
            .addQueryParameter("offset", offset.toString()).addQueryParameter("limit", "100")
            .addQueryParameter("available", "true").build().encodedPathAndQuery()
        return TrackJson.library(JSONObject(request(path)))
    }
    suspend fun starred(): Set<String> {
        val rows = JSONObject(request("/api/starred")).optJSONArray("song_ids") ?: JSONArray()
        return (0 until rows.length()).map { "nd:${rows.getString(it)}" }.toSet()
    }
    suspend fun liked(): List<Track> = TrackJson.songs(JSONObject(request("/api/nd/liked")).getJSONArray("songs"))
    suspend fun playlists(): List<QqPlaylist> {
        val rows = JSONArray(request("/api/playlists"))
        return (0 until rows.length()).map { i -> rows.getJSONObject(i).let { QqPlaylist(it.getString("id"), it.getString("name"), it.optInt("song_count")) } }
    }
    suspend fun playlist(id: String): List<Track> {
        val url = base.newBuilder().addPathSegment("api").addPathSegment("playlists").addPathSegment(id).build()
        return TrackJson.songs(JSONObject(request(url.encodedPath)).getJSONArray("tracks"))
    }
    suspend fun setLiked(id: String, liked: Boolean) {
        require(id.startsWith("nd:")) { "Трек ещё не добавлен в библиотеку" }
        request("/api/star", JSONObject().put("song_ids", JSONArray().put(id.removePrefix("nd:")))
            .put("unstar", !liked).put("client", "android").put("event_id", UUID.randomUUID().toString()))
    }
    fun streamUrl(ref: String): String = base.newBuilder().addPathSegments("api/listen/stream")
        .addQueryParameter("ref", ref).addQueryParameter("full", "1").build().toString()
    fun coverUrl(path: String?): String? = path?.let { base.resolve(it) }
        ?.takeIf { ServerAddress.sameOrigin(base, it) && it.username.isEmpty() && it.password.isEmpty() }?.toString()
    private fun okhttp3.HttpUrl.encodedPathAndQuery() = encodedPath + (encodedQuery?.let { "?$it" } ?: "")
}

object AppGraph {
    lateinit var store: SessionStore; private set
    lateinit var cookies: SessionCookies; private set
    lateinit var api: QqMusicApi; private set
    fun initialize(context: android.content.Context) {
        store = SessionStore(context.applicationContext)
        configure(store.server)
    }
    fun configure(server: String) {
        val origin = ServerAddress.parse(server)
        if (::api.isInitialized && api.origin == origin.toString().trimEnd('/')) return
        cookies = SessionCookies(store, origin)
        api = QqMusicApi(origin.toString(), cookies)
    }
}
