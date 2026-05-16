# Translator Server

Это внутренний компонент проекта.

Не запускайте его отдельными bat-файлами. Основной сценарий:

```bat
..\setup_windows.bat
..\run_all_servers.bat
```

Ручной запуск нужен только для разработки:

```bat
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8765
```
