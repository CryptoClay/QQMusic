"""Only recognized temporary failures trigger unattended download retries."""

import asyncio
import re

import httpx
from fastapi import HTTPException


class TransientDownloadError(Exception):
    pass


def transient(error: Exception | str) -> bool:
    if isinstance(
        error,
        (
            TransientDownloadError,
            httpx.TimeoutException,
            httpx.NetworkError,
            httpx.RemoteProtocolError,
            asyncio.TimeoutError,
            ConnectionError,
        ),
    ):
        return True
    if isinstance(error, (httpx.HTTPStatusError, HTTPException)):
        status = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else error.status_code
        return status in (408, 425, 429) or 500 <= status <= 599
    if isinstance(error, (ValueError, TypeError, KeyError, PermissionError, FileNotFoundError)):
        return False
    message = str(error).lower()
    if re.search(
        r"\b(?:400|401|403|404|410|413|415|422)\b|captcha|not a bot|не робот|cookies|login|unsupported|invalid|quota|квот",
        message,
    ):
        return False
    return bool(
        re.search(
            r"\b(?:408|425|429|50[0-9]|51[0-9])\b|timeout|timed out|temporar|connection (?:reset|refused|aborted)|network|offline|сеть|временн|таймаут",
            message,
        )
    )
