from pydantic import BaseModel, Field

class Track(BaseModel):
    id: str
    title: str
    artist: str
    duration: int = Field(ge=0)
    artwork: str | None = None
    provider: str
