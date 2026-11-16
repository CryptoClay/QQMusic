package ru.qqmusic.app.playback

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Process
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CommandButton
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionError
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ru.qqmusic.app.MainActivity
import ru.qqmusic.app.data.AppGraph

/** One player owned by the service; activity recreation never interrupts its queue. */
@UnstableApi
class PlaybackService : MediaSessionService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var session: MediaSession? = null
    private lateinit var player: ExoPlayer
    private var likePending = false

    override fun onCreate() {
        super.onCreate()
        // The same cookie jar authenticates API calls and audio, including Range requests.
        val dataSource = OkHttpDataSource.Factory(AppGraph.api.http)
            .setUserAgent("QQMusic-Android")
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource))
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()

        val activity = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        session = MediaSession.Builder(this, player)
            .setSessionActivity(activity)
            .setCallback(SessionCallback())
            .setBitmapLoader(CacheBitmapLoader(DataSourceBitmapLoader(
                DataSourceBitmapLoader.DEFAULT_EXECUTOR_SERVICE.get(), dataSource, null, 512,
            )))
            .setMediaButtonPreferences(listOf(likeButton(false, false)))
            .build()
        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                updateButtons()
            }

            override fun onMediaMetadataChanged(mediaMetadata: MediaMetadata) {
                updateButtons()
            }

            override fun onPlayerError(error: PlaybackException) {
                // Never surface source URLs, cookies or provider exceptions in notification text.
                val unauthorized = generateSequence<Throwable>(error) { it.cause }.any {
                    it is HttpDataSource.InvalidResponseCodeException && it.responseCode == 401
                }
                session?.setSessionExtras(Bundle().apply {
                    putString(
                        ERROR_KEY,
                        if (unauthorized) "Сессия истекла. Войдите снова."
                        else "Не удалось воспроизвести трек. Проверьте соединение.",
                    )
                })
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_READY) session?.setSessionExtras(Bundle.EMPTY)
            }
        })
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Playback deliberately survives closing the UI; an idle service can be reclaimed.
        if (!isPlaybackOngoing) stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        session?.release()
        session = null
        if (::player.isInitialized) player.release()
        super.onDestroy()
    }

    private fun canLike(session: MediaSession, controller: MediaSession.ControllerInfo): Boolean =
        controller.isTrusted && (
            controller.uid == Process.myUid() || controller.uid == Process.SYSTEM_UID ||
                session.isMediaNotificationController(controller)
            )

    private inner class SessionCallback : MediaSession.Callback {
        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
        ): MediaSession.ConnectionResult {
            if (!controller.isTrusted) return MediaSession.ConnectionResult.reject()
            val commands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
                .remove(Player.COMMAND_SEEK_BACK)
                .remove(Player.COMMAND_SEEK_FORWARD)
            // Bluetooth and System UI can control playback, but cannot inject arbitrary URIs.
            if (controller.uid != Process.myUid()) {
                commands.remove(Player.COMMAND_CHANGE_MEDIA_ITEMS)
                    .remove(Player.COMMAND_SET_MEDIA_ITEM)
            }
            val sessionCommands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
            if (canLike(session, controller)) sessionCommands.add(TOGGLE_LIKE)
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailablePlayerCommands(commands.build())
                .setAvailableSessionCommands(sessionCommands.build())
                .build()
        }

        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> {
            if (controller.uid != Process.myUid() || mediaItems.any { !validItem(it) }) {
                return Futures.immediateFailedFuture(SecurityException("Недопустимый источник аудио"))
            }
            return Futures.immediateFuture(mediaItems)
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ): ListenableFuture<SessionResult> {
            if (customCommand.customAction != LIKE_ACTION || !canLike(session, controller)) {
                return Futures.immediateFuture(SessionResult(SessionError.ERROR_PERMISSION_DENIED))
            }
            val current = player.currentMediaItem
            if (current == null || likePending) {
                return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
            }
            val ref = current.mediaId
            val target = !(current.mediaMetadata.extras?.getBoolean(LIKED_KEY) ?: false)
            val api = AppGraph.api
            val future = SettableFuture.create<SessionResult>()
            likePending = true
            updateButtons()
            scope.launch {
                try {
                    withContext(Dispatchers.IO) { api.setLiked(ref, target) }
                    // A skipped track must not receive the previous track's late response.
                    if (AppGraph.api === api) {
                        for (index in 0 until player.mediaItemCount) {
                            val item = player.getMediaItemAt(index)
                            if (item.mediaId == ref) {
                                val extras = Bundle(item.mediaMetadata.extras ?: Bundle.EMPTY)
                                    .apply { putBoolean(LIKED_KEY, target) }
                                player.replaceMediaItem(
                                    index,
                                    item.buildUpon().setMediaMetadata(
                                        item.mediaMetadata.buildUpon().setExtras(extras).build(),
                                    ).build(),
                                )
                            }
                        }
                    }
                    future.set(SessionResult(SessionResult.RESULT_SUCCESS))
                } catch (cancelled: CancellationException) {
                    future.cancel(false)
                    throw cancelled
                } catch (_: Exception) {
                    future.set(SessionResult(SessionError.ERROR_UNKNOWN))
                } finally {
                    likePending = false
                    updateButtons()
                }
            }
            return future
        }
    }

    private fun validItem(item: MediaItem): Boolean {
        val uri = item.localConfiguration?.uri ?: return false
        val origin = Uri.parse(AppGraph.api.origin)
        return item.mediaId.startsWith("nd:") &&
            uri.scheme == "https" && uri.scheme == origin.scheme &&
            uri.host == origin.host && uri.port == origin.port &&
            uri.userInfo == null && uri.fragment == null &&
            uri.path == "/api/listen/stream" && uri.getQueryParameter("ref") == item.mediaId
    }

    private fun updateButtons() {
        val activeSession = session ?: return
        val current = player.currentMediaItem
        activeSession.setMediaButtonPreferences(
            listOf(likeButton(current?.mediaMetadata?.extras?.getBoolean(LIKED_KEY) ?: false,
                current != null && !likePending)),
        )
    }

    private fun likeButton(liked: Boolean, enabled: Boolean): CommandButton =
        CommandButton.Builder(if (liked) CommandButton.ICON_HEART_FILLED else CommandButton.ICON_HEART_UNFILLED)
            .setDisplayName(if (liked) "Убрать из любимых" else "В любимые")
            .setSessionCommand(TOGGLE_LIKE)
            .setSlots(CommandButton.SLOT_BACK_SECONDARY, CommandButton.SLOT_OVERFLOW)
            .setEnabled(enabled)
            .build()

    companion object {
        const val LIKE_ACTION = "ru.qqmusic.app.TOGGLE_LIKE"
        const val LIKED_KEY = "liked"
        const val ERROR_KEY = "playback_error"
        val TOGGLE_LIKE = SessionCommand(LIKE_ACTION, Bundle.EMPTY)
    }
}
