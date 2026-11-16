package ru.qqmusic.app

import android.app.Application
import ru.qqmusic.app.data.AppGraph

class QqMusicApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        AppGraph.initialize(this)
    }
}
