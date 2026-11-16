package ru.qqmusic.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.Crossfade
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ru.qqmusic.app.AppState
import ru.qqmusic.app.AppViewModel
import ru.qqmusic.app.PlaybackState
import ru.qqmusic.app.data.Track

private val Orange = Color(0xFFFF934B)
private val Background = Color(0xFF101211)
private val Surface = Color(0xFF1B1E1C)
private val Muted = Color(0xFFABB4AD)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QqMusicApp(vm: AppViewModel) {
    val state by vm.state.collectAsState()
    val playback by vm.playback.collectAsState()
    var expanded by rememberSaveable { mutableStateOf(false) }
    MaterialTheme(colorScheme = darkColorScheme(primary = Orange, onPrimary = Background,
        background = Background, surface = Surface, onSurface = Color(0xFFF4F6F2),
        secondary = Color(0xFF91D2BE), surfaceContainer = Surface)) {
        Surface(Modifier.fillMaxSize(), color = Background) {
            Crossfade(targetState = when { state.restoring -> "restore"; state.user == null -> "login"; else -> "music" }, label = "account") { screen ->
                when (screen) {
                    "restore" -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    "login" -> Login(state, vm::login)
                    else -> Scaffold(containerColor = Background, topBar = {
                        TopAppBar(title = { Column {
                            Text("QQMusic", fontWeight = FontWeight.Bold)
                            Text(state.user.orEmpty(), style = MaterialTheme.typography.labelSmall, color = Muted)
                        } }, actions = { IconButton(onClick = { expanded = false; vm.logout() }) {
                            Icon(Icons.Default.Logout, "Выйти из аккаунта")
                        } }, colors = TopAppBarDefaults.topAppBarColors(containerColor = Background))
                    }, bottomBar = { Column {
                        if (playback.ref != null) MiniPlayer(playback, { expanded = true }, vm)
                        NavigationBar(containerColor = Background) {
                            NavigationBarItem(selected = state.page == "library", onClick = vm::openLibrary,
                                icon = { Icon(Icons.Default.LibraryMusic, null) }, label = { Text("Музыка") })
                            NavigationBarItem(selected = state.page == "liked", onClick = vm::openLiked,
                                icon = { Icon(Icons.Default.Favorite, null) }, label = { Text("Любимое") })
                            NavigationBarItem(selected = state.page.startsWith("playlist"), onClick = vm::openPlaylists,
                                icon = { Icon(Icons.Default.QueueMusic, null) }, label = { Text("Плейлисты") })
                        }
                    } }) { insets ->
                        Library(state, playback, vm, Modifier.padding(insets))
                    }
                }
            }
            if (expanded && state.user != null && playback.ref != null) {
                ModalBottomSheet(onDismissRequest = { expanded = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Surface) {
                    FullPlayer(playback, vm)
                }
            }
        }
    }
}

@Composable
private fun Login(state: AppState, submit: (String, String, String) -> Unit) {
    var server by rememberSaveable(state.server) { mutableStateOf(state.server) }
    var user by rememberSaveable { mutableStateOf("") }
    // Password is kept only in composition memory, never in saved instance state.
    var password by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().systemBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(28.dp),
        verticalArrangement = Arrangement.Center) {
        Cover(Modifier.size(76.dp), large = true)
        Spacer(Modifier.height(20.dp))
        Text("Твоя музыка.\nТвоя частота.", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
        Text("Войти в QQMusic", color = Muted, modifier = Modifier.padding(vertical = 16.dp))
        OutlinedTextField(server, { server = it }, label = { Text("Адрес сервера") }, modifier = Modifier.fillMaxWidth(),
            singleLine = true, enabled = !state.busy, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next))
        OutlinedTextField(user, { user = it }, label = { Text("Логин") }, modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
            singleLine = true, enabled = !state.busy, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next))
        OutlinedTextField(password, { password = it }, label = { Text("Пароль") }, modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
            singleLine = true, enabled = !state.busy, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done))
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp)) }
        Button(onClick = { submit(server.trim(), user.trim(), password) }, enabled = !state.busy && server.isNotBlank() && user.isNotBlank() && password.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().padding(top = 20.dp).height(52.dp)) {
            if (state.busy) CircularProgressIndicator(Modifier.size(22.dp), color = Background, strokeWidth = 2.dp) else Text("Войти", fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun Library(state: AppState, playback: PlaybackState, vm: AppViewModel, modifier: Modifier) {
    Column(modifier.fillMaxSize()) {
        Text(state.title, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
        if (state.page == "library") OutlinedTextField(state.query, vm::setQuery,
            placeholder = { Text("Трек или исполнитель") }, leadingIcon = { Icon(Icons.Default.Search, null) },
            trailingIcon = { if (state.query.isNotEmpty()) IconButton(onClick = { vm.setQuery("") }) { Icon(Icons.Default.Close, "Очистить поиск") } },
            singleLine = true, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 12.dp))
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { message ->
            Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth().padding(16.dp), shape = RoundedCornerShape(16.dp)) {
                Column(Modifier.padding(14.dp)) {
                    Text(message, color = MaterialTheme.colorScheme.onErrorContainer)
                    TextButton(onClick = vm::retry) { Text("Повторить") }
                }
            }
        }
        AnimatedContent(targetState = state.page, modifier = Modifier.weight(1f),
            transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "library page") { page ->
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
                if (page == "playlists") {
                    itemsIndexed(state.playlists, key = { _, item -> item.id }) { _, item ->
                        ListItem(headlineContent = { Text(item.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            supportingContent = { Text("Треков: ${item.count}") }, leadingContent = { Cover(Modifier.size(48.dp)) },
                            trailingContent = { Icon(Icons.Default.ChevronRight, null) },
                            modifier = Modifier.clickable { vm.openPlaylist(item.id) }, colors = ListItemDefaults.colors(containerColor = Background))
                    }
                } else {
                    itemsIndexed(state.tracks, key = { index, item -> "$index:${item.ref}" }) { _, track ->
                        TrackRow(track, playback.ref == track.ref, { vm.play(track) }, { vm.toggleLike(track) })
                    }
                    if (state.nextOffset != null) item { Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        TextButton(onClick = vm::loadMore, enabled = !state.busy) { Text("Показать ещё") }
                    } }
                }
                val empty = if (page == "playlists") state.playlists.isEmpty() else state.tracks.isEmpty()
                if (empty && !state.busy && state.error == null) item { Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.MusicNote, null, Modifier.size(48.dp), tint = Orange)
                    Text(if (state.query.isNotBlank()) "Ничего не найдено" else "Здесь пока тихо", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp))
                    Text(if (state.query.isNotBlank()) "Попробуй другое название или исполнителя" else "Музыка появится после добавления на сервер", color = Muted)
                } }
            }
        }
    }
}

@Composable
private fun TrackRow(track: Track, current: Boolean, play: () -> Unit, like: () -> Unit) {
    ListItem(headlineContent = { Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (current) Orange else MaterialTheme.colorScheme.onSurface) },
        supportingContent = { Text(if (track.playable) track.artist else "${track.artist} · ещё обрабатывается", maxLines = 1, overflow = TextOverflow.Ellipsis, color = Muted) },
        leadingContent = { Cover(Modifier.size(48.dp)) }, trailingContent = { IconButton(onClick = like) {
            Icon(if (track.liked) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                if (track.liked) "Убрать из любимого: ${track.title}" else "Нравится: ${track.title}", tint = if (track.liked) Orange else Muted)
        } }, modifier = Modifier.clickable(enabled = track.playable, onClick = play), colors = ListItemDefaults.colors(containerColor = Background))
}

@Composable
private fun MiniPlayer(p: PlaybackState, expand: () -> Unit, vm: AppViewModel) {
    Surface(color = Surface, shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp).clickable(onClick = expand)) {
        Column {
            Row(Modifier.padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Cover(Modifier.size(42.dp))
                Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                    Text(p.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
                    Text(p.artist, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Muted, style = MaterialTheme.typography.bodySmall)
                }
                LikeButton(p, vm)
                IconButton(onClick = vm::togglePlayback) { Icon(if (p.isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow, if (p.isPlaying) "Пауза" else "Продолжить", tint = Orange) }
                IconButton(onClick = vm::skipNext) { Icon(Icons.Default.SkipNext, "Следующий трек") }
            }
            if (p.duration > 0) LinearProgressIndicator(progress = { (p.position.toFloat() / p.duration).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().height(2.dp))
        }
    }
}

@Composable
private fun FullPlayer(p: PlaybackState, vm: AppViewModel) {
    var scrub by remember(p.ref) { mutableStateOf<Float?>(null) }
    Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("СЕЙЧАС ЗВУЧИТ", style = MaterialTheme.typography.labelMedium, color = Muted)
        Cover(Modifier.padding(vertical = 20.dp).size(164.dp), large = true)
        Text(p.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(p.artist, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        p.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
        Slider(value = scrub ?: if (p.duration > 0) (p.position.toFloat() / p.duration).coerceIn(0f, 1f) else 0f,
            onValueChange = { scrub = it }, enabled = p.duration > 0,
            onValueChangeFinished = { scrub?.let { vm.seekTo((it * p.duration).toLong()) }; scrub = null })
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(clock(p.position), color = Muted); Text(clock(p.duration), color = Muted) }
        Row(Modifier.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            IconButton(onClick = vm::skipPrevious) { Icon(Icons.Default.SkipPrevious, "Предыдущий трек", Modifier.size(32.dp)) }
            FilledIconButton(onClick = vm::togglePlayback, modifier = Modifier.size(64.dp)) { Icon(if (p.isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow, if (p.isPlaying) "Пауза" else "Продолжить", Modifier.size(36.dp)) }
            IconButton(onClick = vm::skipNext) { Icon(Icons.Default.SkipNext, "Следующий трек", Modifier.size(32.dp)) }
            LikeButton(p, vm)
        }
        Text("Очередь · ${p.queue.size}", modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp), fontWeight = FontWeight.SemiBold)
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 200.dp), contentPadding = PaddingValues(bottom = 16.dp)) {
            itemsIndexed(p.queue, key = { i, t -> "$i:${t.ref}" }) { _, track -> TrackRow(track, track.ref == p.ref, { vm.play(track) }, { vm.toggleLike(track) }) }
        }
    }
}

@Composable
private fun LikeButton(p: PlaybackState, vm: AppViewModel) {
    IconButton(onClick = { p.ref?.let { ref -> vm.toggleLike(p.queue.firstOrNull { it.ref == ref }?.copy(liked = p.liked) ?: Track(ref = ref, title = p.title, artist = p.artist, liked = p.liked)) } }) {
        Icon(if (p.liked) Icons.Default.Favorite else Icons.Default.FavoriteBorder, if (p.liked) "Убрать текущий трек из любимого" else "Нравится текущий трек", tint = if (p.liked) Orange else Muted)
    }
}

@Composable
private fun Cover(modifier: Modifier, large: Boolean = false) {
    Box(modifier.background(Brush.linearGradient(listOf(Color(0xFF3E665B), Color(0xFF312039), Color(0xFF663E25))), RoundedCornerShape(if (large) 24.dp else 12.dp)), contentAlignment = Alignment.Center) {
        Icon(Icons.Default.MusicNote, null, Modifier.size(if (large) 54.dp else 25.dp), tint = Orange)
    }
}

private fun clock(ms: Long): String { val seconds = ms.coerceAtLeast(0) / 1000; return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}" }
