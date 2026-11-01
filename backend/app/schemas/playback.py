from pydantic import BaseModel
from typing import Literal

class Playback(BaseModel):
    type: Literal["direct", "embedded"]
    url: str
    mime_type: str | None = None
