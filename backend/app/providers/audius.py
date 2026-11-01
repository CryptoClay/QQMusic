import httpx

from .base import MusicProvider
from app.schemas import Track, Playback

class AudiusProvider(MusicProvider):


    async def search(self, query: str) -> list[Track]:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                "https://api.audius.co/v1/tracks/search",
                params={"query": f"{query}"}
            )
            response.raise_for_status()
            data = response.json()
            print(data)


    async def get_track(self, track_id: str) -> Track | None:
        raise NotImplementedError


    async def get_playback(self, track_id: str) -> Playback | None:
        raise NotImplementedError
