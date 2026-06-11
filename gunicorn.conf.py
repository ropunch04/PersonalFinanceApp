import atexit

from apscheduler.schedulers.background import BackgroundScheduler

from services.sync_service import scheduled_sync_all

bind = "0.0.0.0:5100"
workers = 2
timeout = 120
preload_app = True
accesslog = "logs/access.log"
errorlog = "logs/gunicorn.log"
loglevel = "info"

_scheduler: BackgroundScheduler | None = None


def on_starting(server):
    global _scheduler
    _scheduler = BackgroundScheduler(daemon=True)
    _scheduler.add_job(scheduled_sync_all, trigger="cron", hour=3, minute=0, misfire_grace_time=300)
    _scheduler.start()
    atexit.register(lambda: _scheduler.running and _scheduler.shutdown(wait=False))


def worker_exit(server, worker):
    pass
