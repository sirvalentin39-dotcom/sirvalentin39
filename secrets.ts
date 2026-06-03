
export interface AppSecrets {
    scriptUrl: string;   // Google Apps Script Web App URL
    secretToken: string; // Токен авторизації адмін-дій
    monobankUrl: string; // Посилання на банку Monobank
    superKey: string;    // Майстер-ключ безліміту
    adminNick: string;   // Нік для +5 спроб
    infinKey: string;    // Прихований ключ безліміту
}


const KEY_PART_CODE = 'e20a4f43c068e8bdc34a0295d8ff3596';


const GIST_ID = '895d2129e1f887f0dd7d0357608be933';

const GIST_FILE_NAME = 'config.json';
const CACHE_KEY = 'app_cfg_cipher_cache_v1';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 годин

// Об'єкт, який заповнюється після loadSecrets() і використовується по всьому App.
export const SECRETS: AppSecrets = {
    scriptUrl: '',
    secretToken: '',
    monobankUrl: '',
    superKey: '',
    adminNick: '',
    infinKey: '',
};

let loaded = false;

function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

interface CipherPayload { k: string; salt: string; iv: string; data: string; }

async function fetchCipher(): Promise<CipherPayload> {
    // 1) Кеш зашифрованих даних (зберігаємо лише ciphertext — безпечно).
    try {
        const cachedRaw = localStorage.getItem(CACHE_KEY);
        if (cachedRaw) {
            const cached = JSON.parse(cachedRaw);
            if (cached && cached.ts && (Date.now() - cached.ts) < CACHE_TTL_MS && cached.payload) {
                return cached.payload as CipherPayload;
            }
        }
    } catch { /* ignore */ }

    // 2) Завантаження з GitHub Gist API (CORS дозволено, secret-gist читається за ID).
    const resp = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        cache: 'no-store',
        headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!resp.ok) throw new Error('Не вдалося завантажити конфігурацію (gist ' + resp.status + ')');
    const gist = await resp.json();
    const file = gist && gist.files && gist.files[GIST_FILE_NAME];
    if (!file || !file.content) throw new Error('Конфігураційний файл відсутній у Gist');
    const payload = JSON.parse(file.content) as CipherPayload;

    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), payload }));
    } catch { /* ignore */ }

    return payload;
}

async function decryptConfig(payload: CipherPayload): Promise<AppSecrets> {
    const passphrase = KEY_PART_CODE + payload.k; // об'єднання двох половин ключа
    const enc = new TextEncoder();

    const baseKey = await crypto.subtle.importKey(
        'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
    const aesKey = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: b64ToBytes(payload.salt), iterations: 100000, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-CBC', length: 256 },
        false,
        ['decrypt']
    );
    const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: b64ToBytes(payload.iv) },
        aesKey,
        b64ToBytes(payload.data)
    );
    const json = new TextDecoder().decode(plainBuf);
    return JSON.parse(json) as AppSecrets;
}

export async function loadSecrets(): Promise<void> {
    if (loaded) return;
    const payload = await fetchCipher();
    const cfg = await decryptConfig(payload);
    Object.assign(SECRETS, cfg);
    loaded = true;
}

export function secretsLoaded(): boolean {
    return loaded;
}
