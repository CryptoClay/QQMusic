package ru.qqmusic.app

import android.app.Application
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import ru.qqmusic.app.data.ApiException
import ru.qqmusic.app.data.AppGraph
import ru.qqmusic.app.data.QqPlaylist
import ru.qqmusic.app.data.Track
import ru.qqmusic.app.playback.PlaybackService

data class AppState(
    val server: String = "https://qqmusic.ru", val user: String? = null, val restoring: Boolean = true,
    val busy: Boolean = false, val error: String? = null, val tracks: List<Track> = emptyList(),
    val playlists: List<QqPlaylist> = emptyList(), val page: String = "library",
    val title: String = "Библиотека", val query: String = "", val nextOffset: Int? = null,
)
data class PlaybackState(
    val ref: String? = null, val title: String = "", val artist: String = "", val isPlaying: Boolean = false,
    val position: Long = 0, val duration: Long = 0, val liked: Boolean = false, val queue: List<Track> = emptyList(),
    val error: String? = null, val connected: Boolean = false,
)

@androidx.annotation.OptIn(UnstableApi::class)
class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val mutableState = MutableStateFlow(AppState(server = AppGraph.store.server))
    val state = mutableState.asStateFlow()
    private val mutablePlayback = MutableStateFlow(PlaybackState())
    val playback = mutablePlayback.asStateFlow()
    private var controller: MediaController? = null
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var dataJob: Job? = null
    private var searchJob: Job? = null
    private var logoutJob: Job? = null
    private var liked = emptySet<String>()
    private var playlistId: String? = null
    private var authEpoch = 0
    private val pendingLikes = mutableSetOf<String>()
    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) { syncPlayer() }
        override fun onPlayerError(error: PlaybackException) {
            mutablePlayback.update { it.copy(error = "Не удалось воспроизвести трек. Проверь сеть и войди снова, если сессия истекла.") }
        }
    }

    init {
        viewModelScope.launch {
            try {
                val user = AppGraph.api.me()
                mutableState.update { it.copy(user = user, restoring = false) }
                connectPlayer(); openLibrary()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (e is ApiException && e.status == 401) AppGraph.cookies.clear()
                mutableState.update { it.copy(restoring = false) }
            }
        }
        viewModelScope.launch {
            while (true) { delay(500); syncPlayer() }
        }
    }

    fun login(server: String, user: String, password: String) {
        if (state.value.busy || logoutJob?.isActive == true) return
        mutableState.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                disconnectPlayer()
                AppGraph.cookies.clear()
                AppGraph.configure(server)
                val name = AppGraph.api.login(user.trim(), password)
                mutableState.value = AppState(server = AppGraph.api.origin, user = name, restoring = false)
                authEpoch++
                connectPlayer(); openLibrary()
            } catch (e: Exception) { handleError(e); mutableState.update { it.copy(busy = false) } }
        }
    }

    fun logout() {
        authEpoch++
        dataJob?.cancel(); searchJob?.cancel(); disconnectPlayer()
        val api = AppGraph.api
        val cookies = AppGraph.cookies
        mutableState.value = AppState(server = api.origin, restoring = false, busy = true)
        liked = emptySet()
        logoutJob = viewModelScope.launch { try { api.logout() } catch (_: Exception) {} finally {
            cookies.clear()
            mutableState.update { it.copy(busy = false) }
        } }
    }

    private fun connectPlayer() {
        val epoch = authEpoch
        val token = SessionToken(getApplication(), ComponentName(getApplication(), PlaybackService::class.java))
        val future = MediaController.Builder(getApplication(), token).buildAsync()
        controllerFuture = future
        future.addListener({
            if (epoch != authEpoch || state.value.user == null) return@addListener
            runCatching {
                controller = future.get()
                controller?.addListener(listener)
                syncPlayer()
            }.onFailure { mutablePlayback.update { it.copy(error = "Не удалось подключить плеер") } }
        }, java.util.concurrent.Executor { android.os.Handler(android.os.Looper.getMainLooper()).post(it) })
    }

    private fun disconnectPlayer() {
        controller?.apply { stop(); clearMediaItems(); removeListener(listener) }
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controller = null; controllerFuture = null
        getApplication<Application>().stopService(Intent(getApplication(), PlaybackService::class.java))
        mutablePlayback.value = PlaybackState()
    }

    fun openLibrary() {
        playlistId = null
        mutableState.update { it.copy(page = "library", title = "Библиотека", tracks = emptyList(), playlists = emptyList(), query = "", nextOffset = null) }
        fetch()
    }
    fun openLiked() {
        playlistId = null
        mutableState.update { it.copy(page = "liked", title = "Любимые треки", tracks = emptyList(), playlists = emptyList(), query = "", nextOffset = null) }
        fetch()
    }
    fun openPlaylists() {
        playlistId = null
        mutableState.update { it.copy(page = "playlists", title = "Твои плейлисты", tracks = emptyList(), query = "", nextOffset = null) }
        fetch()
    }
    fun openPlaylist(id: String) {
        playlistId = id
        val name = state.value.playlists.find { it.id == id }?.name ?: "Плейлист"
        mutableState.update { it.copy(page = "playlist", title = name, tracks = emptyList(), query = "", nextOffset = null) }
        fetch()
    }
    fun setQuery(query: String) {
        mutableState.update { it.copy(query = query, nextOffset = null) }
        dataJob?.cancel(); searchJob?.cancel()
        searchJob = viewModelScope.launch { delay(350); fetch() }
    }
    fun loadMore() { state.value.nextOffset?.let { fetch(it) } }
    fun retry() { fetch() }

    private fun fetch(offset: Int = 0) {
        dataJob?.cancel()
        val snapshot = state.value
        val selected = playlistId
        val epoch = authEpoch
        dataJob = viewModelScope.launch {
            mutableState.update { it.copy(busy = true, error = null) }
            try {
                liked = AppGraph.api.starred()
                when (snapshot.page) {
                    "library" -> {
                        val result = AppGraph.api.library(snapshot.query, offset)
                        mutableState.update { it.copy(tracks = (if (offset == 0) emptyList() else it.tracks) + result.tracks.map { t -> t.copy(liked = t.ref in liked) }, nextOffset = result.next) }
                    }
                    "liked" -> {
                        val tracks = AppGraph.api.liked().map { t -> t.copy(liked = true) }
                        mutableState.update { it.copy(tracks = tracks) }
                    }
                    "playlists" -> {
                        val lists = AppGraph.api.playlists()
                        mutableState.update { it.copy(playlists = lists) }
                    }
                    "playlist" -> if (selected != null) {
                        val tracks = AppGraph.api.playlist(selected).map { t -> t.copy(liked = t.ref in liked) }
                        mutableState.update { it.copy(tracks = tracks) }
                    }
                }
            } catch (e: Exception) { handleError(e) }
            finally { if (epoch == authEpoch) mutableState.update { it.copy(busy = false) } }
        }
    }

    fun play(track: Track) {
        if (!track.playable) return
        val player = controller ?: return
        val visible = state.value.tracks.filter { it.playable }
        val list = if (visible.any { it.ref == track.ref }) visible else playback.value.queue
        val index = list.indexOfFirst { it.ref == track.ref }
        if (index < 0) return
        val items = list.map { t ->
            val metadata = MediaMetadata.Builder().setTitle(t.title).setArtist(t.artist).setAlbumTitle(t.album)
                .setIsPlayable(true).setIsBrowsable(false)
                .setArtworkUri(AppGraph.api.coverUrl(t.cover)?.let { android.net.Uri.parse(it) })
                .setExtras(Bundle().apply { putBoolean("liked", t.ref in liked || t.liked) }).build()
            MediaItem.Builder().setMediaId(t.ref).setUri(AppGraph.api.streamUrl(t.ref)).setMediaMetadata(metadata).build()
        }
        mutablePlayback.update { it.copy(queue = list, error = null) }
        player.setMediaItems(items, index, 0); player.prepare(); player.play()
    }
    fun togglePlayback() { controller?.let { if (it.isPlaying) it.pause() else { if (it.playbackState == Player.STATE_IDLE) it.prepare(); it.play() } } }
    fun skipNext() { controller?.seekToNextMediaItem() }
    fun skipPrevious() { controller?.seekToPreviousMediaItem() }
    fun seekTo(ms: Long) { controller?.seekTo(ms.coerceAtLeast(0)) }
    fun toggleLike(track: Track) {
        if (!track.ref.startsWith("nd:")) return
        if (!pendingLikes.add(track.ref)) return
        val epoch = authEpoch
        val api = AppGraph.api
        viewModelScope.launch {
            try {
                val value = !(track.ref in liked)
                api.setLiked(track.ref, value)
                if (epoch != authEpoch || api !== AppGraph.api) return@launch
                liked = if (value) liked + track.ref else liked - track.ref
                mutableState.update { it.copy(tracks = it.tracks.map { t -> if (t.ref == track.ref) t.copy(liked = value) else t }) }
                controller?.let { p ->
                    for (i in 0 until p.mediaItemCount) {
                        val item = p.getMediaItemAt(i)
                        if (item.mediaId == track.ref) p.replaceMediaItem(i, item.buildUpon().setUri(AppGraph.api.streamUrl(item.mediaId)).setMediaMetadata(item.mediaMetadata.buildUpon()
                            .setExtras(Bundle(item.mediaMetadata.extras ?: Bundle()).apply { putBoolean("liked", value) }).build()).build())
                    }
                }
                mutablePlayback.update { it.copy(queue = it.queue.map { t -> if (t.ref == track.ref) t.copy(liked = value) else t }) }
            } catch (e: Exception) { if (epoch == authEpoch) handleError(e) }
            finally { pendingLikes.remove(track.ref) }
        }
    }

    private fun syncPlayer() {
        val player = controller ?: return
        val item = player.currentMediaItem
        val isLiked = item?.mediaMetadata?.extras?.getBoolean("liked") == true
        if (item != null) liked = if (isLiked) liked + item.mediaId else liked - item.mediaId
        val queue = (0 until player.mediaItemCount).map { index ->
            val entry = player.getMediaItemAt(index)
            val metadata = entry.mediaMetadata
            Track(entry.mediaId, metadata.title?.toString() ?: "", metadata.artist?.toString() ?: "",
                metadata.albumTitle?.toString() ?: "", cover = metadata.artworkUri?.toString(), liked = metadata.extras?.getBoolean("liked") == true)
        }
        mutablePlayback.update { it.copy(ref = item?.mediaId, title = item?.mediaMetadata?.title?.toString() ?: "",
            artist = item?.mediaMetadata?.artist?.toString() ?: "", isPlaying = player.isPlaying,
            position = player.currentPosition.coerceAtLeast(0), duration = player.duration.coerceAtLeast(0), liked = isLiked,
            connected = true, queue = queue) }
        mutableState.update { it.copy(tracks = it.tracks.map { t -> t.copy(liked = t.ref in liked) }) }
    }
    private fun handleError(e: Exception) {
        if (e is CancellationException) throw e
        if (e is ApiException && e.status == 401 && state.value.user != null) {
            logout(); mutableState.update { it.copy(error = e.message) }; return
        }
        mutableState.update { it.copy(error = if (e is ApiException || e is IllegalArgumentException) e.message else "Нет связи с сервером. Проверь адрес и подключение.") }
    }
    override fun onCleared() {
        controller?.removeListener(listener)
        controllerFuture?.let { MediaController.releaseFuture(it) }
        super.onCleared()
    }
}
