package ru.qqmusic.app.data

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONArray
import org.json.JSONObject

data class Track(
    val ref: String, val title: String, val artist: String, val album: String = "",
    val duration: Double = 0.0, val cover: String? = null, val liked: Boolean = false,
    val playable: Boolean = true,
)
data class QqPlaylist(val id: String, val name: String, val count: Int)
data class TrackPage(val tracks: List<Track>, val next: Int?)

object ServerAddress {
    fun parse(input: String): HttpUrl {
        val url = input.trim().toHttpUrl()
        require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() &&
            url.encodedPath == "/" && url.query == null && url.fragment == null) {
            "Укажи HTTPS-адрес сервера без пути, например https://qqmusic.ru"
        }
        return url
    }
    fun sameOrigin(a: HttpUrl, b: HttpUrl) = a.scheme == b.scheme && a.host == b.host && a.port == b.port
}

internal fun JSONObject.stringOrNull(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf { it.isNotBlank() }

object TrackJson {
    fun library(json: JSONObject): TrackPage {
        val rows = json.optJSONArray("tracks") ?: JSONArray()
        return TrackPage((0 until rows.length()).map { index ->
            val t = rows.getJSONObject(index)
            val nd = t.stringOrNull("nd_song_id")
            Track(ref = nd?.let { "nd:$it" } ?: "pending:${t.getLong("id")}",
                title = t.optString("title"), artist = t.optString("artist"),
                album = t.optString("album").takeUnless { it == "null" } ?: "",
                duration = t.optDouble("duration_s", 0.0).takeIf { it.isFinite() } ?: 0.0,
                cover = t.stringOrNull("album_id")?.toLongOrNull()?.let { "/api/library/albums/$it/cover?size=300" },
                playable = nd != null && t.optBoolean("available", true))
        }, if (json.isNull("next_offset")) null else json.getInt("next_offset"))
    }

    fun songs(rows: JSONArray): List<Track> = (0 until rows.length()).map { index ->
        val t = rows.getJSONObject(index)
        val ref = t.stringOrNull("nd_song_id")?.let { "nd:$it" } ?: t.getString("ref")
        Track(ref, t.optString("title"), t.optString("artist"), t.stringOrNull("album_title") ?: "",
            t.optDouble("duration_s", 0.0).takeIf { it.isFinite() } ?: 0.0,
            t.stringOrNull("cover_url"), playable = ref.startsWith("nd:"))
    }
}
