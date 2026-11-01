import httpx

from .base import MusicProvider
from app.schemas import Track, Playback

class AudiusProvider(MusicProvider):


    async def search(self, query: str) -> list[Track]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                "https://api.audius.co/v1/tracks/search",
                params={"query": query}
            )
            response.raise_for_status()
            data = response.json()
            tracks = [
                self._parse_track(item)
                for item in data.get("data", [])
            ]
            return tracks


    async def get_track(self, track_id: str) -> Track | None:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"https://api.audius.co/v1/tracks/{track_id}"
            )
            if response.status_code == 404:
                return None
            
            response.raise_for_status()
            data = response.json()
            return self._parse_track(data.get("data", []))


    async def get_playback(self, track_id: str) -> Playback | None:
        raise NotImplementedError


    def _parse_track(self, item: dict) -> Track:
        return Track(
            id=item["id"],
            title=item["title"],
            artist=item["user"]["name"],
            duration=item["duration"],
            artwork=(item.get("artwork") or {}).get("480x480"),
            provider="audius"
        )
