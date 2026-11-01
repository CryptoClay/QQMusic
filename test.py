from abc import ABC, abstractmethod


class MusicProvider(ABC):


    @abstractmethod
    async def search(self, query: str) -> list[Track]:
        pass


    @abstractmethod
    async def get_track(self, track_id: str) -> Track | None:
        pass


    @abstractmethod
    async def get_playback(self, track_id: str) -> Playback:
        pass
