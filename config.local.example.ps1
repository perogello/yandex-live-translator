# Copy this file to config.local.ps1 and edit only if your paths are non-standard.
# Keep values empty to use auto-detection.

$ProjectConfig = @{
  # Optional. Example: "D:\AI\Ollama" or "F:\AI"
  OllamaModelsPath = ""

  # Optional. Example: "C:\Users\you\AppData\Local\Programs\Ollama\ollama.exe"
  OllamaExe = ""

  # Optional. Example: "C:\Program Files\Yandex\YandexBrowser\Application\browser.exe"
  YandexBrowserPath = ""

  # Model used by setup checks and documentation messages.
  DefaultOllamaModel = "translategemma:12b"

  # Local ports. Change only if these ports are already used by another app.
  TranslatorPort = 8765
  CdpReaderPort = 8766
  YandexDebugPort = 9222

  # When true, launcher closes already-running Yandex Browser without asking.
  AutoCloseYandex = $false
}
