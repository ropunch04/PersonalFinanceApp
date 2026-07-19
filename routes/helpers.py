"""Shared response envelope for all API blueprints."""


def _ok(data):
    return {"data": data, "error": None}


def _err(message, status):
    return {"data": None, "error": message}, status
