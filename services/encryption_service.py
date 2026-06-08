from cryptography.fernet import Fernet, InvalidToken

import config


def get_fernet() -> Fernet:
    try:
        return Fernet(config.ENCRYPTION_KEY.encode())
    except Exception as exc:
        raise ValueError(f"ENCRYPTION_KEY is missing or invalid: {exc}") from exc


def encrypt(plaintext: str) -> str:
    return get_fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    try:
        return get_fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken as exc:
        raise ValueError("Decryption failed — wrong key or corrupted data.") from exc
