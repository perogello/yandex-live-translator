# Subtitle CDP Reader

Это внутренний компонент проекта.

Он читает субтитры из Яндекс Браузера через Chrome DevTools Protocol.

Не запускайте его отдельными bat-файлами. Основной сценарий:

```bat
..\setup_windows.bat
..\run_all_servers.bat
```

Ручная проверка debug-порта Яндекса:

```text
http://127.0.0.1:9222/json
```

Ручной запуск reader нужен только для разработки:

```bat
.venv\Scripts\python.exe -m uvicorn server:app --host 127.0.0.1 --port 8766
```
