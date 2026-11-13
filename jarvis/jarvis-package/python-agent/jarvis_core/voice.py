"""
JARVIS Voice Interface Module

Provides speech-to-text (STT) and text-to-speech (TTS) capabilities
for the JARVIS AI Agent. Supports multiple STT backends and configurable
voice parameters.

Features:
    - Speech recognition via Google Web Speech API, OpenAI Whisper, and Sphinx
    - Text-to-speech via pyttsx3 with configurable voice/rate/volume
    - Asynchronous listen and speak methods
    - Continuous listening mode for always-on voice interaction
    - Real-time audio stream processing via AsyncGenerator
    - Graceful fallback between STT backends
    - Comprehensive error handling for microphone access issues

Dependencies:
    - SpeechRecognition: For STT with multiple backends
    - pyttsx3: For offline TTS synthesis
    - pyaudio: For microphone audio capture (optional, falls back gracefully)
"""

from __future__ import annotations

import asyncio
import io
import logging
import queue
import threading
import time
import wave
from enum import Enum
from typing import Any, AsyncGenerator, Optional

logger = logging.getLogger(__name__)


class STTBackend(str, Enum):
    """Enumeration of supported speech-to-text backends.

    - GOOGLE: Google Web Speech API (free, requires internet)
    - WHISPER: OpenAI Whisper API (requires API key)
    - SPHINX: CMU Sphinx (offline, limited accuracy)
    """
    GOOGLE = "google"
    WHISPER = "whisper"
    SPHINX = "sphinx"


class VoiceState(str, Enum):
    """Enumeration of voice interface states.

    - IDLE: No active audio capture or playback
    - LISTENING: Actively capturing audio from microphone
    - PROCESSING: Processing captured audio (STT)
    - SPEAKING: Actively synthesizing speech (TTS)
    - ERROR: Error state, requires recovery
    """
    IDLE = "idle"
    LISTENING = "listening"
    PROCESSING = "processing"
    SPEAKING = "speaking"
    ERROR = "error"


class AudioConfig:
    """Configuration for audio capture and playback.

    Attributes:
        sample_rate: Audio sample rate in Hz.
        chunk_size: Audio chunk size in samples.
        channels: Number of audio channels (1=mono, 2=stereo).
        listen_timeout: Maximum seconds to listen before timing out.
        phrase_time_limit: Maximum seconds for a single phrase.
        silence_threshold: RMS threshold for silence detection.
        silence_duration: Seconds of silence before stopping capture.
    """

    def __init__(
        self,
        sample_rate: int = 16000,
        chunk_size: int = 1024,
        channels: int = 1,
        listen_timeout: Optional[float] = None,
        phrase_time_limit: Optional[float] = None,
        silence_threshold: int = 500,
        silence_duration: float = 1.5,
    ) -> None:
        """Initialize AudioConfig.

        Args:
            sample_rate: Audio sample rate in Hz.
            chunk_size: Audio chunk size in samples.
            channels: Number of audio channels.
            listen_timeout: Max listen duration in seconds.
            phrase_time_limit: Max phrase duration in seconds.
            silence_threshold: RMS threshold for silence detection.
            silence_duration: Seconds of silence before stopping.
        """
        self.sample_rate: int = sample_rate
        self.chunk_size: int = chunk_size
        self.channels: int = channels
        self.listen_timeout: Optional[float] = listen_timeout
        self.phrase_time_limit: Optional[float] = phrase_time_limit
        self.silence_threshold: int = silence_threshold
        self.silence_duration: float = silence_duration


class VoiceInterface:
    """Voice interface for JARVIS AI Agent with STT and TTS capabilities.

    Provides asynchronous methods for listening to microphone input,
    converting speech to text, and synthesizing speech from text.
    Supports multiple STT backends with automatic fallback.

    Args:
        stt_backend: The primary STT backend to use.
        whisper_api_key: Optional OpenAI API key for Whisper STT.
        whisper_model: Whisper model name (e.g., 'whisper-1').
        tts_voice_id: Voice identifier for TTS (engine-dependent).
        tts_rate: Speech rate in words per minute (default: 200).
        tts_volume: Volume level from 0.0 to 1.0 (default: 1.0).
        audio_config: Optional AudioConfig for customizing capture.
        language: Language code for STT (e.g., 'en-US').

    Example:
        >>> voice = VoiceInterface(stt_backend=STTBackend.GOOGLE)
        >>> text = await voice.listen()
        >>> await voice.speak("Good day, sir. How may I assist you?")
    """

    def __init__(
        self,
        stt_backend: STTBackend | str = STTBackend.GOOGLE,
        whisper_api_key: Optional[str] = None,
        whisper_model: str = "whisper-1",
        tts_voice_id: Optional[int] = None,
        tts_rate: int = 200,
        tts_volume: float = 1.0,
        audio_config: Optional[AudioConfig] = None,
        language: str = "en-US",
    ) -> None:
        """Initialize the VoiceInterface.

        Args:
            stt_backend: Primary STT backend to use.
            whisper_api_key: OpenAI API key for Whisper backend.
            whisper_model: Whisper model identifier.
            tts_voice_id: TTS voice identifier (index for pyttsx3).
            tts_rate: Speech rate in words per minute.
            tts_volume: Volume from 0.0 to 1.0.
            audio_config: Optional audio configuration.
            language: Language code for speech recognition.
        """
        # STT backend
        if isinstance(stt_backend, str):
            try:
                self._stt_backend = STTBackend(stt_backend)
            except ValueError:
                logger.warning(
                    "Unknown STT backend '%s', defaulting to Google", stt_backend
                )
                self._stt_backend = STTBackend.GOOGLE
        else:
            self._stt_backend = stt_backend

        self._whisper_api_key: Optional[str] = whisper_api_key
        self._whisper_model: str = whisper_model
        self._language: str = language

        # Audio configuration
        self._audio_config: AudioConfig = audio_config or AudioConfig()

        # State management
        self._state: VoiceState = VoiceState.IDLE
        self._state_lock: asyncio.Lock = asyncio.Lock()
        self._continuous_listening: bool = False
        self._listen_thread: Optional[threading.Thread] = None
        self._audio_queue: queue.Queue[bytes] = queue.Queue()
        self._result_queue: queue.Queue[str] = queue.Queue()
        self._stop_event: threading.Event = threading.Event()

        # Initialize SpeechRecognition recognizer
        self._recognizer = None
        self._microphone = None
        try:
            import speech_recognition as sr
            self._recognizer = sr.Recognizer()
            self._recognizer.energy_threshold = 300
            self._recognizer.dynamic_energy_threshold = True
            self._recognizer.pause_threshold = 0.8

            # Try to initialize microphone
            try:
                self._microphone = sr.Microphone()
                # Calibrate for ambient noise
                with self._microphone as source:
                    self._recognizer.adjust_for_ambient_noise(source, duration=0.5)
                logger.info("Microphone initialized and calibrated")
            except (OSError, AttributeError, Exception) as e:
                logger.warning("Microphone not available: %s", e)
                self._microphone = None
        except ImportError:
            logger.warning("SpeechRecognition not installed. STT will be unavailable.")

        # Initialize pyttsx3 TTS engine
        self._tts_engine = None
        self._tts_voice_id: Optional[int] = tts_voice_id
        self._tts_rate: int = tts_rate
        self._tts_volume: float = tts_volume
        self._tts_lock: threading.Lock = threading.Lock()
        try:
            import pyttsx3
            self._tts_engine = pyttsx3.init()
            self._tts_engine.setProperty("rate", tts_rate)
            self._tts_engine.setProperty("volume", tts_volume)
            if tts_voice_id is not None:
                voices = self._tts_engine.getProperty("voices")
                if 0 <= tts_voice_id < len(voices):
                    self._tts_engine.setProperty("voice", voices[tts_voice_id].id)
            logger.info(
                "TTS engine initialized (rate=%d, volume=%.1f)", tts_rate, tts_volume
            )
        except (ImportError, Exception) as e:
            logger.warning("pyttsx3 TTS not available: %s", e)
            self._tts_engine = None

        # Voice activity detection
        self._vad_enabled: bool = False

        logger.info(
            "VoiceInterface initialized: backend=%s, language=%s",
            self._stt_backend.value,
            self._language,
        )

    @property
    def state(self) -> VoiceState:
        """Return the current voice interface state.

        Returns:
            The current VoiceState.
        """
        return self._state

    @property
    def is_listening(self) -> bool:
        """Check if the voice interface is currently listening.

        Returns:
            True if in LISTENING state.
        """
        return self._state == VoiceState.LISTENING

    @property
    def is_speaking(self) -> bool:
        """Check if the voice interface is currently speaking.

        Returns:
            True if in SPEAKING state.
        """
        return self._state == VoiceState.SPEAKING

    async def _set_state(self, new_state: VoiceState) -> None:
        """Update the voice interface state.

        Args:
            new_state: The new VoiceState to set.
        """
        async with self._state_lock:
            old_state = self._state
            self._state = new_state
            if old_state != new_state:
                logger.debug("Voice state: %s -> %s", old_state.value, new_state.value)

    async def listen(self, timeout: Optional[float] = None) -> str:
        """Capture audio from the microphone and convert to text.

        Listens for speech input, processes it through the configured
        STT backend, and returns the transcribed text. Falls back to
        alternative backends if the primary fails.

        Args:
            timeout: Optional timeout in seconds for listening. Uses
                audio_config.listen_timeout if not specified.

        Returns:
            The transcribed text string, or an empty string on failure.

        Raises:
            RuntimeError: If microphone is not available.
        """
        if self._recognizer is None:
            raise RuntimeError("SpeechRecognition not initialized")

        if self._microphone is None:
            raise RuntimeError(
                "Microphone not available. Check audio device permissions."
            )

        await self._set_state(VoiceState.LISTENING)

        timeout = timeout or self._audio_config.listen_timeout
        phrase_limit = self._audio_config.phrase_time_limit

        try:
            with self._microphone as source:
                logger.info("Listening for speech input...")
                audio = self._recognizer.listen(
                    source,
                    timeout=timeout,
                    phrase_time_limit=phrase_limit,
                )

            await self._set_state(VoiceState.PROCESSING)

            # Try primary backend, then fallbacks
            text = await self._recognize_speech(audio)
            return text

        except Exception as e:
            await self._set_state(VoiceState.ERROR)
            logger.error("Error during listening: %s", e)

            # Handle specific microphone errors
            error_msg = str(e).lower()
            if "no default input device" in error_msg:
                logger.error("No microphone detected. Please connect an audio input device.")
            elif "permission" in error_msg:
                logger.error(
                    "Microphone permission denied. Grant access in system settings."
                )
            return ""

        finally:
            await self._set_state(VoiceState.IDLE)

    async def _recognize_speech(self, audio: Any) -> str:
        """Process audio through the STT backend with fallback.

        Attempts to recognize speech using the primary backend. If it fails,
        falls back to alternative backends in order.

        Args:
            audio: The AudioData object from SpeechRecognition.

        Returns:
            The recognized text, or empty string if all backends fail.
        """
        # Define backend order with fallbacks
        backend_order: list[STTBackend] = [self._stt_backend]
        for backend in STTBackend:
            if backend not in backend_order:
                backend_order.append(backend)

        for backend in backend_order:
            try:
                if backend == STTBackend.GOOGLE:
                    text = await self._recognize_google(audio)
                elif backend == STTBackend.WHISPER:
                    text = await self._recognize_whisper(audio)
                elif backend == STTBackend.SPHINX:
                    text = await self._recognize_sphinx(audio)
                else:
                    continue

                if text:
                    logger.info(
                        "Speech recognized (%s): %s",
                        backend.value,
                        text[:100],
                    )
                    return text

            except Exception as e:
                logger.warning(
                    "STT backend %s failed: %s. Trying fallback...",
                    backend.value,
                    e,
                )
                continue

        logger.warning("All STT backends failed")
        return ""

    async def _recognize_google(self, audio: Any) -> str:
        """Recognize speech using Google Web Speech API.

        Args:
            audio: The AudioData object from SpeechRecognition.

        Returns:
            The recognized text string.

        Raises:
            Exception: If Google STT fails.
        """
        if self._recognizer is None:
            raise RuntimeError("SpeechRecognition not initialized")

        # Run in executor to avoid blocking the event loop
        loop = asyncio.get_event_loop()
        text = await loop.run_in_executor(
            None,
            lambda: self._recognizer.recognize_google(audio, language=self._language),
        )
        return text

    async def _recognize_whisper(self, audio: Any) -> str:
        """Recognize speech using OpenAI Whisper API.

        Args:
            audio: The AudioData object from SpeechRecognition.

        Returns:
            The recognized text string.

        Raises:
            ValueError: If Whisper API key is not configured.
            Exception: If Whisper API call fails.
        """
        if not self._whisper_api_key:
            raise ValueError("Whisper API key not configured")

        try:
            import openai
            client = openai.OpenAI(api_key=self._whisper_api_key)

            # Convert audio to WAV format for Whisper
            wav_data = io.BytesIO()
            wav_data.write(audio.get_wav_data())
            wav_data.seek(0)
            wav_data.name = "recording.wav"

            # Run API call in executor
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: client.audio.transcriptions.create(
                    model=self._whisper_model,
                    file=wav_data,
                    language=self._language.split("-")[0],  # 'en-US' -> 'en'
                ),
            )
            return response.text

        except ImportError:
            raise RuntimeError("OpenAI package not installed for Whisper STT")

    async def _recognize_sphinx(self, audio: Any) -> str:
        """Recognize speech using CMU Sphinx (offline).

        Args:
            audio: The AudioData object from SpeechRecognition.

        Returns:
            The recognized text string.

        Raises:
            Exception: If Sphinx recognition fails.
        """
        if self._recognizer is None:
            raise RuntimeError("SpeechRecognition not initialized")

        loop = asyncio.get_event_loop()
        text = await loop.run_in_executor(
            None,
            lambda: self._recognizer.recognize_sphinx(audio),
        )
        return text

    async def speak(self, text: str) -> None:
        """Convert text to speech and play it through speakers.

        Uses pyttsx3 for offline TTS synthesis. The method runs TTS
        in a separate thread to avoid blocking the async event loop.

        Args:
            text: The text string to synthesize as speech.
        """
        if not text.strip():
            logger.debug("Empty text, skipping TTS")
            return

        await self._set_state(VoiceState.SPEAKING)

        if self._tts_engine is None:
            logger.warning("TTS engine not available, skipping speech synthesis")
            await self._set_state(VoiceState.IDLE)
            return

        try:
            # Run TTS in a thread to avoid blocking
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, self._speak_sync, text)
        except Exception as e:
            logger.error("TTS error: %s", e)
            await self._set_state(VoiceState.ERROR)
        finally:
            await self._set_state(VoiceState.IDLE)

    def _speak_sync(self, text: str) -> None:
        """Synchronous TTS execution (runs in a thread).

        Args:
            text: The text to synthesize.
        """
        with self._tts_lock:
            try:
                self._tts_engine.say(text)
                self._tts_engine.runAndWait()
            except Exception as e:
                logger.error("Synchronous TTS error: %s", e)

    async def speak_and_listen(self, text: str, listen_timeout: Optional[float] = None) -> str:
        """Speak text and then immediately listen for a response.

        This is a convenience method that combines speak() and listen()
        for conversational voice interactions.

        Args:
            text: The text to speak first.
            listen_timeout: Optional timeout for the subsequent listen.

        Returns:
            The transcribed text from the user's response.
        """
        await self.speak(text)
        # Brief pause after speaking to avoid picking up own voice
        await asyncio.sleep(0.5)
        return await self.listen(timeout=listen_timeout)

    async def audio_stream(self, chunk_duration: float = 0.1) -> AsyncGenerator[bytes, None]:
        """Generate a real-time audio stream from the microphone.

        Yields audio chunks as bytes for real-time processing, such as
        streaming to a WebSocket or feeding into a custom audio pipeline.

        Args:
            chunk_duration: Duration of each audio chunk in seconds.

        Yields:
            Raw audio data bytes from the microphone.

        Raises:
            RuntimeError: If microphone is not available.
        """
        if self._microphone is None:
            raise RuntimeError("Microphone not available for audio streaming")

        await self._set_state(VoiceState.LISTENING)
        self._stop_event.clear()

        try:
            import speech_recognition as sr

            # Calculate chunk size in samples
            chunk_samples = int(
                self._audio_config.sample_rate * chunk_duration
            )

            with self._microphone as source:
                stream = source.stream

                while not self._stop_event.is_set():
                    try:
                        # Read audio chunk
                        chunk = stream.read(chunk_samples)
                        if chunk:
                            yield chunk
                    except IOError as e:
                        logger.warning("Audio stream read error: %s", e)
                        await asyncio.sleep(0.01)
                        continue

        except Exception as e:
            logger.error("Audio stream error: %s", e)
            await self._set_state(VoiceState.ERROR)
        finally:
            await self._set_state(VoiceState.IDLE)

    def stop_audio_stream(self) -> None:
        """Stop the ongoing audio stream.

        Signals the audio_stream generator to stop yielding chunks.
        """
        self._stop_event.set()
        logger.info("Audio stream stopped")

    async def listen_continuous(
        self,
        callback: Any,
        idle_timeout: Optional[float] = None,
    ) -> None:
        """Start continuous listening mode for always-on voice interaction.

        Continuously listens for speech, processes it through STT, and
        calls the provided callback with each recognized text. Runs
        until stop_continuous() is called or idle_timeout is reached.

        Args:
            callback: Async callable that receives the transcribed text.
            idle_timeout: Optional timeout in seconds with no speech
                before automatically stopping. None for no timeout.

        Example:
            >>> async def handle_speech(text):
            ...     print(f"Heard: {text}")
            >>> await voice.listen_continuous(handle_speech, idle_timeout=300)
        """
        self._continuous_listening = True
        self._stop_event.clear()
        last_speech_time = time.time()

        logger.info("Continuous listening started (timeout=%s)", idle_timeout)

        try:
            while self._continuous_listening and not self._stop_event.is_set():
                try:
                    text = await self.listen(timeout=5.0)
                    if text:
                        last_speech_time = time.time()
                        if asyncio.iscoroutinefunction(callback):
                            await callback(text)
                        else:
                            callback(text)
                    else:
                        # Check idle timeout
                        if idle_timeout and (
                            time.time() - last_speech_time > idle_timeout
                        ):
                            logger.info("Continuous listening idle timeout")
                            break

                except Exception as e:
                    logger.error("Continuous listening error: %s", e)
                    await asyncio.sleep(1.0)
                    await self._set_state(VoiceState.IDLE)

        finally:
            self._continuous_listening = False
            await self._set_state(VoiceState.IDLE)
            logger.info("Continuous listening stopped")

    def stop_continuous(self) -> None:
        """Stop continuous listening mode.

        Signals the listen_continuous loop to exit after the current
        listening cycle completes.
        """
        self._continuous_listening = False
        self._stop_event.set()
        logger.info("Continuous listening stop requested")

    def set_voice(self, voice_id: int) -> None:
        """Set the TTS voice by index.

        Args:
            voice_id: The voice index to use (0-based).
        """
        if self._tts_engine is None:
            logger.warning("TTS engine not available")
            return

        try:
            voices = self._tts_engine.getProperty("voices")
            if 0 <= voice_id < len(voices):
                self._tts_engine.setProperty("voice", voices[voice_id].id)
                self._tts_voice_id = voice_id
                logger.info("Voice set to: %s", voices[voice_id].name)
            else:
                logger.warning(
                    "Invalid voice_id %d (available: 0-%d)",
                    voice_id,
                    len(voices) - 1,
                )
        except Exception as e:
            logger.error("Error setting voice: %s", e)

    def set_rate(self, rate: int) -> None:
        """Set the TTS speech rate.

        Args:
            rate: Speech rate in words per minute (typical: 100-300).
        """
        if self._tts_engine is None:
            logger.warning("TTS engine not available")
            return

        try:
            self._tts_engine.setProperty("rate", rate)
            self._tts_rate = rate
            logger.info("TTS rate set to: %d WPM", rate)
        except Exception as e:
            logger.error("Error setting rate: %s", e)

    def set_volume(self, volume: float) -> None:
        """Set the TTS volume level.

        Args:
            volume: Volume level from 0.0 (mute) to 1.0 (maximum).
        """
        if self._tts_engine is None:
            logger.warning("TTS engine not available")
            return

        volume = max(0.0, min(1.0, volume))
        try:
            self._tts_engine.setProperty("volume", volume)
            self._tts_volume = volume
            logger.info("TTS volume set to: %.1f", volume)
        except Exception as e:
            logger.error("Error setting volume: %s", e)

    def get_available_voices(self) -> list[dict[str, str]]:
        """Return a list of available TTS voices.

        Returns:
            A list of dictionaries with 'id', 'name', and 'languages' keys.
        """
        if self._tts_engine is None:
            return []

        try:
            voices = self._tts_engine.getProperty("voices")
            result: list[dict[str, str]] = []
            for i, voice in enumerate(voices):
                result.append({
                    "id": str(i),
                    "name": voice.name,
                    "languages": str(voice.languages) if voice.languages else "",
                })
            return result
        except Exception as e:
            logger.error("Error getting voices: %s", e)
            return []

    def get_microphone_info(self) -> dict[str, Any]:
        """Return information about the available microphone.

        Returns:
            A dictionary with microphone availability and details.
        """
        info: dict[str, Any] = {
            "available": self._microphone is not None,
            "microphone_type": type(self._microphone).__name__ if self._microphone else "None",
        }

        if self._recognizer:
            info["energy_threshold"] = self._recognizer.energy_threshold
            info["dynamic_energy_threshold"] = self._recognizer.dynamic_energy_threshold
            info["pause_threshold"] = self._recognizer.pause_threshold

        try:
            import speech_recognition as sr
            mic_list = sr.Microphone.list_microphone_names()
            info["device_count"] = len(mic_list)
            info["device_names"] = mic_list[:5]  # Show first 5
        except Exception:
            info["device_count"] = 0

        return info

    def get_status(self) -> dict[str, Any]:
        """Return the current voice interface status.

        Returns:
            A dictionary with voice interface status information.
        """
        return {
            "state": self._state.value,
            "stt_backend": self._stt_backend.value,
            "language": self._language,
            "continuous_listening": self._continuous_listening,
            "tts_available": self._tts_engine is not None,
            "tts_rate": self._tts_rate,
            "tts_volume": self._tts_volume,
            "tts_voice_id": self._tts_voice_id,
            "microphone": self.get_microphone_info(),
            "audio_config": {
                "sample_rate": self._audio_config.sample_rate,
                "chunk_size": self._audio_config.chunk_size,
                "channels": self._audio_config.channels,
                "silence_threshold": self._audio_config.silence_threshold,
            },
        }

    def __repr__(self) -> str:
        """Return a string representation of the VoiceInterface."""
        return (
            f"VoiceInterface(backend={self._stt_backend.value}, "
            f"state={self._state.value}, "
            f"language={self._language})"
        )
