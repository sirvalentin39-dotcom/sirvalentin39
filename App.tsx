
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GoogleGenAI } from '@google/genai';
import { ProcessingState } from './types';
import { SECRETS } from './secrets';

// Чутливі дані (URL скрипта, токен, monobank, ключі) завантажуються та
// розшифровуються з приватного Gist при старті застосунку — див. ./secrets.ts

// Let TypeScript know about the JSZip and puter global variables from the CDN
declare var JSZip: any;
declare var puter: any;

type View = 'menu' | 'auto' | 'auto_with_api' | 'manual' | 'unlimited' | 'admin';

// --- USAGE LIMIT CONSTANTS ---
const USAGE_LIMIT = 3;
const LS_KEYS = {
    USAGE: 'mc_translator_total_usage',
    UNLIMITED: 'mc_translator_unlimited',
    ACTIVATION_CODES_USED: 'mc_translator_activation_codes_used',
    PROMO_CODES_USED: 'mc_translator_promo_codes_used',
    DEV_MODE: 'mc_translator_dev_mode',
    USER_ID: 'mc_translator_user_id',
    PROVISIONED: 'mc_translator_provisioned_keys', // For special feature
    API_KEYS_LIST: 'gemini_api_keys_list',
    ACTIVE_API_KEY_ID: 'gemini_active_api_key_id',
    SELECTED_AI_MODEL: 'gemini_selected_ai_model',
};
// Майстер-ключ, нік для +5 спроб та прихований ключ безліміту тепер беруться
// із зашифрованої конфігурації: SECRETS.superKey / SECRETS.adminNick / SECRETS.infinKey

const COMPLETION_MARKER = "---TRANSLATION_COMPLETED_CUBE_CRAFT_STUDIO---";
const CONTINUE_PROMPT_PHRASE = ">>CONTINUE_TRANSLATION>>";

interface LangFileInfo {
    fullPath: string;
    content: string;
    textsPath: string;
    languagesJson: string;
}

interface ApiKey {
    id: string;
    name: string;
    key: string;
}

// --- DATA STRUCTURES AND HELPERS ---

interface ParsedLine {
    isTranslatable: boolean;
    content?: string;
    key?: string;
    comment?: string;
}

interface ParsedLangInfo {
    fullPath: string;
    skeleton: ParsedLine[];
    originalValues: string[];
}

interface TranslationState {
    processingState: ProcessingState;
    statusSteps: string[];
    currentStep: number;
    errorMessage: string | null;
    downloadLink: string | null;
    originalFile: File | null;
    originalFileName: string | null;
    originalLangFiles: LangFileInfo[];
    parsedFiles: ParsedLangInfo[];
    totalChars: number;
    elapsedTime: number;
    estimatedTime: number;
    debugPrompt: string;
    debugResponse: string;
    isValidatingScripts?: boolean;
    scriptsThatNeedTranslation?: ParsedLangInfo[];
    scriptsThatAreEncryptedAndNeedTranslation?: ParsedLangInfo[];
    isolatedJsTranslations?: Record<string, string>;
}

const initialTranslationState: TranslationState = {
    processingState: ProcessingState.IDLE,
    statusSteps: [],
    currentStep: -1,
    errorMessage: null,
    downloadLink: null,
    originalFile: null,
    originalFileName: null,
    originalLangFiles: [],
    parsedFiles: [],
    totalChars: 0,
    elapsedTime: 0,
    estimatedTime: 0,
    debugPrompt: '',
    debugResponse: '',
    isValidatingScripts: false,
    scriptsThatNeedTranslation: undefined,
    scriptsThatAreEncryptedAndNeedTranslation: undefined,
    isolatedJsTranslations: undefined
};


const START_DELIMITER = '§{';
const END_DELIMITER = '}§';

const getIsTelegram = (): boolean => {
    if (typeof window === 'undefined') return false;
    const tg = (window as any).Telegram?.WebApp;
    const ua = navigator.userAgent.toLowerCase();
    return !!tg || ua.includes('telegram') || window.location.href.toLowerCase().includes('tgwebapp');
};

const safePuterChatWithTimeout = async (prompt: string, model: string, timeoutMs: number = 4000): Promise<string> => {
    if (typeof (window as any).puter === 'undefined' || !(window as any).puter?.ai?.chat) {
        throw new Error("Puter is not available on this internet connection.");
    }
    
    const apiCall = (window as any).puter.ai.chat(prompt, { model });
    return Promise.race([
        apiCall.then((r: any) => {
            if (!r || !r.message || !r.message.content) {
                throw new Error("Invalid response from Puter");
            }
            return r.message.content;
        }),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("Puter request timeout")), timeoutMs))
    ]);
};

const downloadTextFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};


function parseLangFile(content: string): { skeleton: ParsedLine[], values: string[] } {
    const skeleton: ParsedLine[] = [];
    const values: string[] = [];
    const lines = content.split(/\r?\n/);

    lines.forEach(line => {
        if (!line.includes('=') || line.trim().startsWith('#')) {
            skeleton.push({ isTranslatable: false, content: line });
        } else {
            const eqIndex = line.indexOf('=');
            const key = line.substring(0, eqIndex + 1);
            let value = line.substring(eqIndex + 1);
            let comment = '';
            
            const commentIndex = value.lastIndexOf('#');
            if (commentIndex > -1) {
                comment = value.substring(commentIndex);
                if (!comment.startsWith(' ')) comment = ' ' + comment;
                value = value.substring(0, commentIndex).trim();
            }
            
            skeleton.push({ isTranslatable: true, key: key, comment: comment });
            values.push(value);
        }
    });

    return { skeleton, values };
}

function rebuildLangFile(skeleton: ParsedLine[], translatedValues: string[], originalValues?: string[]): string {
    let translationIndex = 0;
    const finalLines = skeleton.map(item => {
        if (item.isTranslatable) {
            let translatedValue = translatedValues[translationIndex];
            if (translatedValue === undefined || translatedValue === null) {
                translatedValue = originalValues?.[translationIndex] ?? '';
            }
            translationIndex++;
            if (item.key && item.key.trim().startsWith('pack.name')) {
                translatedValue = translatedValue.replace(/\s*\|\s*Перекладено\s+CubeCraft\s+Studio\.?/gi, "").trim();
                translatedValue = `${translatedValue} | Перекладено CubeCraft Studio.`;
            } else if (item.key && item.key.trim().startsWith('pack.description')) {
                translatedValue = translatedValue.replace(/\s*\|\s*Наш\s+тгк\s*:?\s*§9https:\/\/t\.me\/CubeCraftStudio/gi, "").trim();
                translatedValue = `${translatedValue} | Наш тгк: §9https://t.me/CubeCraftStudio`;
            }
            return `${item.key ?? ''}${translatedValue}${item.comment ?? ''}`;
        } else {
            return item.content ?? '';
        }
    });
    return finalLines.join('\n');
}

function extractStringsFromJS(code: string): string[] {
    const rawStrings: {quote: string, value: string, full: string}[] = [];
    const regex = /(["'`])((?:[^\\]|\\.)*?)\1/g;
    let match;
    while ((match = regex.exec(code)) !== null) {
        const full = match[0];
        const quote = match[1];
        const value = match[2];
        rawStrings.push({ quote, value, full });
    }
    
    const valid: string[] = [];
    const seen = new Set<string>();
    
    for (const item of rawStrings) {
        const v = item.value;
        const trimmed = v.trim();
        
        if (!/[A-Za-zА-Яа-яЄєІіЇїҐґ]{2,}/.test(trimmed)) continue;
        if (/\\x[0-9a-fA-F]{2}/.test(v) || /\\u[0-9a-fA-F]{4}/.test(v)) continue;
        
        if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes(':')) {
            if (!trimmed.includes(' ')) continue;
        }
        
        if (trimmed.length > 25 && !trimmed.includes(' ') && !trimmed.includes(',') && !trimmed.includes('.')) continue;
        if (/^[a-zA-Z0-9_$]+$/.test(trimmed)) continue;
        
        if (!seen.has(v)) {
            seen.add(v);
            valid.push(v);
        }
    }
    return valid;
}

function processJSFile(code: string, originalStrings: string[], translatedValues: string[]): string {
    let result = code;
    for (let i = 0; i < originalStrings.length; i++) {
        const orig = originalStrings[i];
        const trans = translatedValues[i] || orig;
        if (orig === trans) continue;
        result = result.split(orig).join(trans);
    }
    return result;
}

function parseManifestFile(content: string, fullPath: string): ParsedLangInfo | null {
    if (content.includes("pack.description") || content.includes("pack.name")) {
        return null;
    }
    try {
        const parsed = JSON.parse(content);
        const originalValues: string[] = [];
        
        if (parsed.header) {
            if (typeof parsed.header.name === 'string' && parsed.header.name) {
                originalValues.push(parsed.header.name);
            }
            if (typeof parsed.header.description === 'string' && parsed.header.description) {
                originalValues.push(parsed.header.description);
            }
        }
        if (Array.isArray(parsed.modules)) {
            for (const mod of parsed.modules) {
                if (typeof mod.description === 'string' && mod.description) {
                    originalValues.push(mod.description);
                }
            }
        }
        
        // Handle "text" component
        if (parsed.text) {
            if (typeof parsed.text === 'string') {
                originalValues.push(parsed.text);
            } else if (Array.isArray(parsed.text)) {
                parsed.text.forEach((t: any) => {
                    if (typeof t === 'string' && t) originalValues.push(t);
                });
            } else if (typeof parsed.text === 'object') {
                for (const key in parsed.text) {
                    if (typeof parsed.text[key] === 'string' && parsed.text[key]) {
                        originalValues.push(parsed.text[key]);
                    }
                }
            }
        }
        
        if (originalValues.length === 0) return null;
        
        return {
            fullPath,
            skeleton: [{ isTranslatable: false, content }],
            originalValues
        };
    } catch (e) {
        console.error("Failed to parse manifest.json", e);
        return null;
    }
}

function rebuildManifestFile(originalContent: string, translatedValues: string[]): string {
    try {
        const parsed = JSON.parse(originalContent);
        let valIndex = 0;
        
        if (parsed.header) {
            if (typeof parsed.header.name === 'string' && parsed.header.name) {
                let transName = translatedValues[valIndex++] || parsed.header.name;
                transName = transName.replace(/\s*\|\s*Перекладено\s+CubeCraft\s+Studio\.?/gi, "").trim();
                parsed.header.name = `${transName} | Перекладено CubeCraft Studio.`;
            }
            if (typeof parsed.header.description === 'string' && parsed.header.description) {
                let transDesc = translatedValues[valIndex++] || parsed.header.description;
                transDesc = transDesc.replace(/\s*\|\s*Наш\s+тгк\s*:?\s*§9https:\/\/t\.me\/CubeCraftStudio/gi, "").trim();
                parsed.header.description = `${transDesc} | Наш тгк: §9https://t.me/CubeCraftStudio`;
            }
        }
        if (Array.isArray(parsed.modules)) {
            for (const mod of parsed.modules) {
                if (typeof mod.description === 'string' && mod.description) {
                    let transDesc = translatedValues[valIndex++] || mod.description;
                    transDesc = transDesc.replace(/\s*\|\s*Наш\s+тгк\s*:?\s*§9https:\/\/t\.me\/CubeCraftStudio/gi, "").trim();
                    mod.description = `${transDesc} | Наш тгк: §9https://t.me/CubeCraftStudio`;
                }
            }
        }
        
        // Handle "text" component rebuild
        if (parsed.text) {
            if (typeof parsed.text === 'string') {
                parsed.text = translatedValues[valIndex++] || parsed.text;
            } else if (Array.isArray(parsed.text)) {
                for (let i = 0; i < parsed.text.length; i++) {
                    if (typeof parsed.text[i] === 'string' && parsed.text[i]) {
                        parsed.text[i] = translatedValues[valIndex++] || parsed.text[i];
                    }
                }
            } else if (typeof parsed.text === 'object') {
                for (const key in parsed.text) {
                    if (typeof parsed.text[key] === 'string' && parsed.text[key]) {
                        parsed.text[key] = translatedValues[valIndex++] || parsed.text[key];
                    }
                }
            }
        }
        
        return JSON.stringify(parsed, null, 2);
    } catch (e) {
        console.error("Error rebuilding manifest.json", e);
        return originalContent;
    }
}

function parseAnyFile(path: string, content: string): ParsedLangInfo | null {
    if (path.endsWith('.json')) {
        return parseManifestFile(content, path);
    } else if (path.endsWith('.js')) {
        const strings = extractStringsFromJS(content);
        if (strings.length === 0) return null;
        return {
            fullPath: path,
            skeleton: [{ isTranslatable: false, content }],
            originalValues: strings
        };
    } else {
        const { skeleton, values } = parseLangFile(content);
        return {
            fullPath: path,
            skeleton,
            originalValues: values
        };
    }
}

function rebuildAnyFile(path: string, skeleton: ParsedLine[], originalStrings: string[], translatedValues: string[]): string {
    if (path.endsWith('.json')) {
        return rebuildManifestFile(skeleton[0]?.content ?? '', translatedValues);
    } else if (path.endsWith('.js')) {
        return processJSFile(skeleton[0]?.content ?? '', originalStrings, translatedValues);
    } else {
        return rebuildLangFile(skeleton, translatedValues, originalStrings);
    }
}

function createTranslationBlock(values: string[]): string {
    return values.map(v => `${START_DELIMITER}${v}${END_DELIMITER}`).join('');
}

function parseTranslationBlock(block: string): string[] {
    // Прибираємо маркер завершення та можливі markdown-огорожі (```), які іноді додає ШІ.
    let cleanBlock = block.replace(COMPLETION_MARKER, '');
    cleanBlock = cleanBlock.replace(/```[a-zA-Z]*/g, '').trim();

    const startIdx = cleanBlock.indexOf(START_DELIMITER);
    const endIdx = cleanBlock.lastIndexOf(END_DELIMITER);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
        return [];
    }

    // Беремо лише вміст між ПЕРШИМ «§{» та ОСТАННІМ «}§».
    const inner = cleanBlock.substring(startIdx + START_DELIMITER.length, endIdx);

    // Блоки склеєні як §{v1}§§{v2}§ — справжній роздільник між значеннями це «}§§{».
    // Розбиваємо саме по ньому (дозволяючи пробіли/переноси між блоками). Це стійко до
    // символів «§» всередині тексту (кольори Minecraft §a, §l, §r) та до плейсхолдерів
    // типу {0}§r, через які стара регулярка рахувала блоки неправильно ("Розбіжність").
    const separatorRegex = new RegExp(
        END_DELIMITER.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') +
        '\\s*' +
        START_DELIMITER.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
    );
    return inner.split(separatorRegex);
}

const formatTime = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
};

const formatEstimatedTime = (totalSeconds: number) => {
    if (totalSeconds < 1) return "< 1 сек";
    if (totalSeconds < 60) return `${Math.ceil(totalSeconds)} сек`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.ceil(totalSeconds % 60);
    if (seconds === 0) return `${minutes} хв`;
    if (seconds === 60) return `${minutes + 1} хв`;
    return `${minutes} хв ${seconds} сек`;
};

// --- ICONS ---

const UploadIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} stroke="currentColor" fill="none" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
    <polyline points="17 8 12 3 7 8"></polyline>
    <line x1="12" y1="3" x2="12" y2="15"></line>
  </svg>
);

const SpinnerIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={`animate-spin ${className}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
  </svg>
);

const CheckIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} stroke="currentColor" fill="none" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);

const ErrorIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} stroke="currentColor" fill="none" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="12" y1="8" x2="12" y2="12"></line>
    <line x1="12" y1="16" x2="12.01" y2="16"></line>
  </svg>
);

const KeyIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>
    </svg>
);

const PencilIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
    </svg>
);

const SparklesIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3L9.27 8.27L4 11L9.27 13.73L12 19L14.73 13.73L20 11L14.73 8.27L12 3z"></path>
        <path d="M5 21L7 17"></path>
        <path d="M17 17L19 21"></path>
    </svg>
);

const ManualIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <line x1="16" y1="13" x2="8" y2="13"></line>
        <line x1="16" y1="17" x2="8" y2="17"></line>
        <polyline points="10 9 9 9 8 9"></polyline>
    </svg>
);

const BackIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 12H5"></path>
        <polyline points="12 19 5 12 12 5"></polyline>
    </svg>
);

const TrashIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} stroke="currentColor" fill="none" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      <line x1="10" y1="11" x2="10" y2="17"></line>
      <line x1="14" y1="11" x2="14" y2="17"></line>
    </svg>
  );
  
const ChevronDownIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9"></polyline>
    </svg>
);

const InfoIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="16" x2="12" y2="12"></line>
        <line x1="12" y1="8" x2="12.01" y2="8"></line>
    </svg>
);

const StopIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <rect x="9" y="9" width="6" height="6"></rect>
    </svg>
);

const CopyIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
);

const GiftIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 12 20 22 4 22 4 12"></polyline>
        <rect x="2" y="7" width="20" height="5"></rect>
        <line x1="12" y1="22" x2="12" y2="7"></line>
        <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C9.8 2 12 4.2 12 7z"></path>
        <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C14.2 2 12 4.2 12 7z"></path>
    </svg>
);

const PlusIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="16"></line>
        <line x1="8" y1="12" x2="16" y2="12"></line>
    </svg>
);

// --- UI HELPER COMPONENTS ---

const CopyButton: React.FC<{ textToCopy: string; className?: string }> = ({ textToCopy, className = '' }) => {
    const [copied, setCopied] = useState(false);
    const handleCopy = () => {
        navigator.clipboard.writeText(textToCopy);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };
    return (
        <button onClick={handleCopy} title="Скопіювати" className={`transition-transform duration-150 ease-in-out active:scale-90 ${className}`}>
            {copied ? <CheckIcon className="w-4 h-4 text-green-400" /> : <CopyIcon className="w-4 h-4 text-gray-400 hover:text-white" />}
        </button>
    );
};

const StatusItem: React.FC<{ text: string; active: boolean; completed: boolean; }> = ({ text, active, completed }) => (
  <div className={`flex items-center space-x-3 transition-colors duration-300 ${active || completed ? 'text-brand-text-primary' : 'text-brand-text-secondary/50'}`}>
    {completed ? <CheckIcon className="w-5 h-5 text-brand-primary" /> : active ? <SpinnerIcon className="w-5 h-5" /> : <div className="w-5 h-5 border-2 border-brand-text-secondary/50 rounded-full"></div>}
    <span>{text}</span>
  </div>
);

const ScriptTranslationOptions: React.FC<{
    translateScripts: boolean;
    setTranslateScripts: (val: boolean) => void;
    zipHasScripts: boolean;
    zipHasEncryptedScripts: boolean;
    allowTranslateEncrypted: boolean;
    setAllowTranslateEncrypted: (val: boolean) => void;
    idPrefix: string;
    encryptedScriptsCharCount?: number;
}> = ({ translateScripts, setTranslateScripts, zipHasScripts, zipHasEncryptedScripts, allowTranslateEncrypted, setAllowTranslateEncrypted, idPrefix, encryptedScriptsCharCount = 0 }) => {
    const [showHelp, setShowHelp] = useState(false);
    return (
        <div className="border border-gray-700/60 bg-brand-surface p-4 mt-2 rounded-xl space-y-3 w-full shadow-lg animate-fade-in">
            <div className={`flex items-center justify-between w-full select-none relative group ${!zipHasScripts && idPrefix !== 'manual' ? 'opacity-50' : ''}`}>
                <div className="flex items-center space-x-3 w-full border border-transparent p-1 rounded transition-colors hover:bg-gray-800/50">
                    <input 
                        id={`${idPrefix}-translate-scripts`}
                        type="checkbox" 
                        checked={translateScripts} 
                        onChange={(e) => setTranslateScripts(e.target.checked)}
                        className="w-4.5 h-4.5 rounded border-gray-600 text-brand-primary focus:ring-brand-primary cursor-pointer transition-shadow"
                    />
                    <label htmlFor={`${idPrefix}-translate-scripts`} className="text-sm font-bold text-gray-200 cursor-pointer w-full tracking-wide">
                        Перекладати скрипти (.js файли)
                    </label>
                </div>
                <button 
                    onClick={() => setShowHelp(!showHelp)} 
                    type="button"
                    className="p-1.5 rounded-full hover:bg-gray-700 text-gray-400 hover:text-brand-primary transition-all cursor-pointer bg-gray-800/80"
                    title="Що це означає?"
                >
                    <InfoIcon className="w-5 h-5" />
                </button>
                
                {showHelp && (
                    <div className="absolute right-0 bottom-full mb-3 w-72 md:w-80 p-4 bg-brand-surface border border-brand-primary/40 rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.5)] z-20 text-xs sm:text-sm text-gray-300 text-left animate-fade-in pointer-events-auto">
                        <strong className="text-white block mb-1 text-sm tracking-tight border-b border-gray-700 pb-1">Про переклад скриптів</strong>
                        Ця опція забезпечить пошук та переклад тексту прямо у файлах скриптів. <br/><br/>
                        <strong className="text-red-400">🚨 УВАГА:</strong> Якщо логіка аддону спирається на цей текст, переклад може зламати роботу аддону в грі. ШІ намагається бути обережним, але ризик залишається.
                    </div>
                )}
            </div>

            {translateScripts && zipHasEncryptedScripts && (
                <div className="flex flex-col gap-3 bg-red-900/20 border border-red-800/50 p-4 rounded-xl select-none animate-fade-in text-left shadow-inner mt-2">
                    <div className="flex items-start space-x-3">
                        <input 
                            id={`${idPrefix}-allow-encrypted`}
                            type="checkbox" 
                            checked={allowTranslateEncrypted} 
                            onChange={(e) => setAllowTranslateEncrypted(e.target.checked)}
                            className="w-4.5 h-4.5 mt-0.5 rounded border-red-700 text-red-500 focus:ring-red-500 cursor-pointer"
                        />
                        <div className="flex-1">
                            <label htmlFor={`${idPrefix}-allow-encrypted`} className="text-xs sm:text-sm font-bold text-red-400 cursor-pointer tracking-wider block">
                                УВАГА: виявлено зашифровані скрипти
                            </label>
                            <span className="text-xs text-gray-300 leading-relaxed block mt-1">
                                Я розумію високі ризики і даю згоду на їх повний переклад за допомогою ШІ. (Без згоди їх буде пропущено)
                            </span>
                        </div>
                    </div>

                    {encryptedScriptsCharCount > 0 && (
                        <div className="pt-2 border-t border-red-900/40 text-xs">
                            <p className="text-gray-300 font-medium">
                                Сукупний розмір коду зашифрованих скриптів: <strong className="text-red-400">{encryptedScriptsCharCount.toLocaleString('uk-UA')}</strong> символів.
                            </p>
                            {encryptedScriptsCharCount >= 100000 && (
                                <div className="mt-2 p-3 bg-red-950/50 border border-red-700 rounded-lg text-[11px] leading-relaxed text-red-200 font-semibold shadow-inner space-y-1">
                                    <p className="uppercase text-red-400 font-extrabold flex items-center gap-1.5 animate-pulse">
                                        ⚠️ ПОПЕРЕДЖЕННЯ: ОБСЯГ КОДУ ЗАДОВГИЙ!
                                    </p>
                                    <p>
                                        Кількість символів перевищує безпечні ліміти ({encryptedScriptsCharCount >= 1000000 ? 'понад 1 мільйон' : 'понад 100 тисяч'}).
                                        Такий переклад за допомогою ШІ триватиме <span className="text-yellow-400 font-bold">надзвичайно довго</span> і може призвести до помилок, обривів генерації або повної непрацездатності коду.
                                    </p>
                                    <p className="text-yellow-400 font-extrabold">Перекладати такий зашифрований обсяг вкрай НЕ РЕКОМЕНДУЄТЬСЯ!</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const AiLogsViewer: React.FC<{ logs: { direction: 'request' | 'response'; model?: string; timestamp: string; content: string; }[] }> = ({ logs }) => {
    if (logs.length === 0) return null;
    return (
        <div className="mt-4 p-4 bg-gray-950/80 border border-gray-700/80 rounded-xl space-y-2 text-left animate-fade-in w-full shadow-2xl">
            <h4 className="text-xs font-bold uppercase text-blue-400 tracking-wider flex items-center justify-between">
                <span>Логи запитів до ШІ (тільки для розробника)</span>
                <span className="bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded-full text-[10px]">Всього: {logs.length}</span>
            </h4>
            <div className="max-h-[400px] overflow-y-auto space-y-3 custom-scrollbar bg-black/40 p-3 border border-gray-800 rounded-lg flex flex-col-reverse">
                {[...logs].reverse().map((L, i) => (
                    <div key={i} className={`p-2.5 rounded border shadow-sm ${L.direction === 'request' ? 'border-purple-800/40 bg-purple-900/20' : 'border-green-800/40 bg-green-900/20'}`}>
                        <div className="flex justify-between items-center mb-1.5 border-b border-gray-800/50 pb-1">
                            <span className={`text-[10px] font-black uppercase tracking-widest ${L.direction === 'request' ? 'text-purple-400' : 'text-green-400'}`}>
                                {L.direction === 'request' ? '➡️ ЗАПИТ' : '⬅️ ВІДПОВІДЬ'} 
                                <span className="text-gray-500 ml-1 font-medium hidden sm:inline">[{L.model}]</span>
                            </span>
                            <span className="text-[10px] text-gray-500 font-mono">{new Date(L.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <div className="text-[11px] font-mono text-gray-300 break-words whitespace-pre-wrap leading-tight select-all">{L.content}</div>
                    </div>
                ))}
            </div>
        </div>
    );
};

// --- CORE PROCESSING LOGIC ---

const zipHasJsScripts = async (zip: any): Promise<boolean> => {
    async function checkRecursively(zipObject: any): Promise<boolean> {
        const jsFiles = zipObject.file(/scripts\/.*\.js$/);
        if (jsFiles.length > 0) return true;

        const nestedArchives = zipObject.file(/\.(mcaddon|mcpack|mctemplate)$/);
        for (const archiveObject of nestedArchives) {
            try {
                const nestedZip = await JSZip.loadAsync(await archiveObject.async('blob'));
                const hasJs = await checkRecursively(nestedZip);
                if (hasJs) return true;
            } catch (e) {
                console.warn("Could not check nested zip for scripts:", e);
            }
        }
        return false;
    }
    return await checkRecursively(zip);
};

const scanForEncryptedScriptsLocally = async (zip: any): Promise<boolean> => {
    async function checkRecursively(zipObject: any): Promise<boolean> {
        const jsFiles = zipObject.file(/scripts\/.*\.js$/);
        for (const fileObject of jsFiles) {
            const content = await fileObject.async('string');
            if (content) {
                if (/_0x[a-f0-9]{4,}/i.test(content) ||
                    /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c/i.test(content) ||
                    /\\x[0-9a-fA-F]{2}/i.test(content) ||
                    (content.includes('eval') && content.length > 5000 && !content.includes(' '))) {
                    return true;
                }
            }
        }
        const nestedArchives = zipObject.file(/\.(mcaddon|mcpack|mctemplate)$/);
        for (const archiveObject of nestedArchives) {
            try {
                const nestedZip = await JSZip.loadAsync(await archiveObject.async('blob'));
                const hasEncrypted = await checkRecursively(nestedZip);
                if (hasEncrypted) return true;
            } catch (e) {
                console.warn("Could not check nested zip for encrypted scripts:", e);
            }
        }
        return false;
    }
    return await checkRecursively(zip);
};

const getEncryptedScriptsTotalSize = async (zip: any): Promise<number> => {
    let totalLength = 0;
    async function calculateRecursively(zipObject: any) {
        const jsFiles = zipObject.file(/scripts\/.*\.js$/);
        for (const fileObject of jsFiles) {
            const content = await fileObject.async('string');
            if (content) {
                const isEncrypted = /_0x[a-f0-9]{4,}/i.test(content) ||
                                    /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c/i.test(content) ||
                                    /\\x[0-9a-fA-F]{2}/i.test(content) ||
                                    (content.includes('eval') && content.length > 5000 && !content.includes(' '));
                if (isEncrypted) {
                    totalLength += content.length;
                }
            }
        }
        const nestedArchives = zipObject.file(/\.(mcaddon|mcpack|mctemplate)$/);
        for (const archiveObject of nestedArchives) {
            try {
                const nestedZip = await JSZip.loadAsync(await archiveObject.async('blob'));
                await calculateRecursively(nestedZip);
            } catch (e) {
                console.warn("Could not check nested zip for size:", e);
            }
        }
    }
    await calculateRecursively(zip);
    return totalLength;
};

async function preProcessScriptsOffline(
    parsedFiles: ParsedLangInfo[]
): Promise<{
    scriptsThatNeedTranslation: ParsedLangInfo[];
    scriptsThatAreEncryptedAndNeedTranslation: ParsedLangInfo[];
    isolatedJsTranslations: Record<string, string>;
}> {
    const scriptsThatNeedTranslation: ParsedLangInfo[] = [];
    const scriptsThatAreEncryptedAndNeedTranslation: ParsedLangInfo[] = [];
    const isolatedJsTranslations: Record<string, string> = {};
    
    let scriptsToScan = parsedFiles.filter(f => f.fullPath.endsWith('.js'));
    for (const file of scriptsToScan) {
        const content = file.skeleton[0]?.content ?? '';
        const isEncrypted = /_0x[a-f0-9]{4,}/i.test(content) ||
                            /eval\s*\(\s*function/i.test(content) ||
                            /eval\s*\(/i.test(content) ||
                            /\\x[0-9a-fA-F]{2}/i.test(content) ||
                            (content.includes('eval') && content.length > 5000 && !content.includes(' '));
        
        const strings = extractStringsFromJS(content);
        if (strings.length > 0) {
            if (isEncrypted) {
                scriptsThatAreEncryptedAndNeedTranslation.push(file);
            } else {
                scriptsThatNeedTranslation.push(file);
            }
        } else {
            isolatedJsTranslations[file.fullPath] = content;
        }
    }
    return { scriptsThatNeedTranslation, scriptsThatAreEncryptedAndNeedTranslation, isolatedJsTranslations };
}

async function writeArbitraryPathInZip(zip: any, fullPath: string, content: string): Promise<boolean> {
    const parts = fullPath.split('/');
    const archiveIndices: number[] = [];
    parts.forEach((part, idx) => {
        if (/\.(mcaddon|mcpack|mctemplate)$/i.test(part)) {
            archiveIndices.push(idx);
        }
    });
    
    if (archiveIndices.length === 0) {
        zip.file(fullPath, content);
        return true;
    }
    
    async function updateNested(currentZip: any, pathParts: string[]): Promise<void> {
        let archiveIdx = -1;
        for (let i = 0; i < pathParts.length; i++) {
            if (/\.(mcaddon|mcpack|mctemplate)$/i.test(pathParts[i])) {
                archiveIdx = i;
                break;
            }
        }
        
        if (archiveIdx === -1) {
            currentZip.file(pathParts.join('/'), content);
            return;
        }
        
        const archiveName = pathParts.slice(0, archiveIdx + 1).join('/');
        const remainingParts = pathParts.slice(archiveIdx + 1);
        
        const archiveFile = currentZip.file(archiveName);
        if (archiveFile) {
            const nestedZip = await JSZip.loadAsync(await archiveFile.async('blob'));
            await updateNested(nestedZip, remainingParts);
            const updatedBlob = await nestedZip.generateAsync({ type: 'blob' });
            currentZip.file(archiveName, updatedBlob, { binary: true });
        }
    }
    
    try {
        await updateNested(zip, parts);
        return true;
    } catch (e) {
        console.error("Error updated arbitrary path in zip:", e);
        return false;
    }
}

async function preProcessScripts(
    parsedFiles: ParsedLangInfo[],
    chatFn: (prompt: string) => Promise<string>,
    addStep: (msg: string) => void,
    cancelledRef?: React.MutableRefObject<boolean>
): Promise<{
    scriptsThatNeedTranslation: ParsedLangInfo[];
    scriptsThatAreEncryptedAndNeedTranslation: ParsedLangInfo[];
    isolatedJsTranslations: Record<string, string>;
}> {
    // Rely on instantaneous offline processing directly to never fail or hang on user's browser
    return preProcessScriptsOffline(parsedFiles);
}

const PermissionModal: React.FC<{
    isOpen: boolean;
    onDecline: () => void;
    onAllow: () => void;
}> = ({ isOpen, onDecline, onAllow }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <div className="bg-[#161a2b] border border-red-500/30 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl relative">
                <div className="flex items-center gap-3 text-red-400">
                    <svg className="w-8 h-8 flex-shrink-0 animate-bounce" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <h3 className="text-xl font-bold tracking-tight">Увага! Скрипти Зашифровано</h3>
                </div>
                <p className="text-gray-300 text-sm leading-relaxed text-left">
                    У цьому аддоні виявлено зашифровані або обфусковані скрипти. Переклад такого коду може призвести до поломки функцій аддону в грі. Ви дійсно хочете спробувати перекласти зашифровані скрипти повністю в один об'єднаний запит?
                </p>
                <div className="flex gap-3 justify-end pt-2">
                    <button 
                        onClick={onDecline}
                        className="px-4 py-2 border border-[#3b82f6]/20 text-gray-400 hover:text-white hover:bg-gray-800 rounded-xl font-semibold transition-all cursor-pointer text-sm"
                    >
                        Відхилити
                    </button>
                    <button 
                        onClick={onAllow}
                        className="px-5 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl font-semibold transition-all shadow-md active:scale-95 cursor-pointer text-sm"
                    >
                        Надати дозвіл
                    </button>
                </div>
            </div>
        </div>
    );
};

const scanAddonForLangFiles = async (
    zip: any, 
    translateScripts: boolean = false, 
    addStepStatusMessage?: (msg: string) => void
): Promise<LangFileInfo[]> => {
    const uniqueResults = new Map<string, LangFileInfo>();

    async function scanRecursively(zipObject: any, pathPrefix: string = ''): Promise<void> {
        // 1. Scan .lang files
        const langFileObjects = zipObject.file(/texts\/en_US\.lang$/);
        for (const fileObject of langFileObjects) {
            const path = pathPrefix + fileObject.name;
            const content = await fileObject.async('string');

            if (!content || !content.includes('=')) continue;

            const textsDir = pathPrefix + fileObject.name.substring(0, fileObject.name.lastIndexOf('en_US.lang'));
            const languagesJsonFile = zipObject.file(`${textsDir.replace(pathPrefix, '')}languages.json`);
            let languagesJsonContent = '["en_US"]';

            if (languagesJsonFile) {
                try {
                    const jsonStr = await languagesJsonFile.async('string');
                    const parsed = JSON.parse(jsonStr);
                    if (Array.isArray(parsed)) languagesJsonContent = jsonStr;
                } catch (e) { console.warn(`Could not parse languages.json for ${path}, using default.`); }
            }

            const fileInfo: LangFileInfo = { fullPath: path, content, textsPath: textsDir, languagesJson: languagesJsonContent };
            if (!uniqueResults.has(fileInfo.fullPath)) uniqueResults.set(fileInfo.fullPath, fileInfo);
        }

        // 2. Scan manifest.json files
        const manifestFileObjects = zipObject.file(/manifest\.json$/);
        for (const fileObject of manifestFileObjects) {
            const path = pathPrefix + fileObject.name;
            const content = await fileObject.async('string');
            if (content) {
                if (content.includes("pack.description") || content.includes("pack.name")) {
                    continue; // Skip because it is localized via .lang!
                }
                const fileInfo: LangFileInfo = { fullPath: path, content, textsPath: '', languagesJson: '' };
                if (!uniqueResults.has(fileInfo.fullPath)) uniqueResults.set(fileInfo.fullPath, fileInfo);
            }
        }

        // 3. Scan scripts/**/*.js files (ONLY if translateScripts is true)
        if (translateScripts) {
            const jsFileObjects = zipObject.file(/scripts\/.*\.js$/);
            let obfuscatedOrNoTextMatched = false;
            let totalJsProcessed = 0;
            let totalExtractedStringsCount = 0;

            for (const fileObject of jsFileObjects) {
                const path = pathPrefix + fileObject.name;
                const content = await fileObject.async('string');
                if (content) {
                    totalJsProcessed++;
                    const strings = extractStringsFromJS(content);
                    if (strings.length > 0) {
                        totalExtractedStringsCount += strings.length;
                        const fileInfo: LangFileInfo = { fullPath: path, content, textsPath: '', languagesJson: '' };
                        if (!uniqueResults.has(fileInfo.fullPath)) uniqueResults.set(fileInfo.fullPath, fileInfo);
                    } else {
                        if (/\\x[0-9a-fA-F]{2}/.test(content) || /\\u[0-9a-fA-F]{4}/.test(content) || (content.length > 5000 && !content.includes(' '))) {
                            obfuscatedOrNoTextMatched = true;
                        }
                    }
                }
            }
            if (totalJsProcessed > 0 && totalExtractedStringsCount === 0) {
                const msg = "Скрипти зашифровані або не містять тексту для перекладу";
                if (addStepStatusMessage) {
                    addStepStatusMessage(msg);
                } else {
                    console.warn(msg);
                }
            }
        }

        const nestedArchives = zipObject.file(/\.(mcaddon|mcpack|mctemplate)$/);
        for (const archiveObject of nestedArchives) {
            try {
                const nestedZip = await JSZip.loadAsync(await archiveObject.async('blob'));
                await scanRecursively(nestedZip, pathPrefix + archiveObject.name + '/');
            } catch(e) { console.warn(`Could not process nested archive ${archiveObject.name}, skipping.`, e); }
        }
    }

    await scanRecursively(zip);
    return Array.from(uniqueResults.values());
};

const applyTranslationsToZip = (zip: any, translations: Record<string, string>, langFiles: LangFileInfo[]): void => {
    for (const fileInfo of langFiles) {
        const translatedContent = translations[fileInfo.fullPath];
        if (translatedContent) {
            if (fileInfo.fullPath.endsWith('.lang')) {
                const newLangPath = fileInfo.fullPath.replace('en_US.lang', 'uk_UA.lang');
                const languagesJsonPath = `${fileInfo.textsPath}languages.json`;
                let languages: string[] = [];
                try { languages = JSON.parse(fileInfo.languagesJson); } catch { languages = ['en_US']; }
                if (!languages.includes('uk_UA')) languages.push('uk_UA');
                const updatedLanguagesJson = JSON.stringify(languages, null, 2);
                zip.file(newLangPath, translatedContent);
                zip.file(languagesJsonPath, updatedLanguagesJson);
            } else {
                zip.file(fileInfo.fullPath, translatedContent);
            }
        }
    }
};

const applyTranslations = async (zip: any, translations: Record<string, string>, allLangFiles: LangFileInfo[]): Promise<any> => {
    const groups = new Map<string, { langFiles: LangFileInfo[], translations: Record<string, string> }>();
    const archiveRegex = /(.*?\.m(caddon|cpack|ctemplate))\/(.*)/;

    const getGroup = (key: string) => {
        if (!groups.has(key)) {
            groups.set(key, { langFiles: [], translations: {} });
        }
        return groups.get(key)!;
    };

    allLangFiles.forEach(fileInfo => {
        const match = fileInfo.fullPath.match(archiveRegex);
        
        if (match) {
            const archiveName = match[1];
            const pathInArchive = match[3];
            const textsPathInArchive = fileInfo.textsPath.replace(archiveName + '/', '');

            const group = getGroup(archiveName);
            group.langFiles.push({ ...fileInfo, fullPath: pathInArchive, textsPath: textsPathInArchive });
            if (translations[fileInfo.fullPath]) {
                group.translations[pathInArchive] = translations[fileInfo.fullPath];
            }
        } else {
            const rootGroup = getGroup('');
            rootGroup.langFiles.push(fileInfo);
            if (translations[fileInfo.fullPath]) {
                rootGroup.translations[fileInfo.fullPath] = translations[fileInfo.fullPath];
            }
        }
    });

    const rootGroup = groups.get('');
    if (rootGroup) {
        applyTranslationsToZip(zip, rootGroup.translations, rootGroup.langFiles);
        groups.delete('');
    }

    for (const [archiveName, group] of groups.entries()) {
        const archiveFile = zip.file(archiveName);
        if (!archiveFile) {
            console.warn(`Could not find nested archive ${archiveName}. Skipping.`);
            continue;
        }
        try {
            const nestedZip = await JSZip.loadAsync(await archiveFile.async('blob'));
            applyTranslationsToZip(nestedZip, group.translations, group.langFiles);
            const updatedArchiveBlob = await nestedZip.generateAsync({ type: 'blob' });
            zip.file(archiveName, updatedArchiveBlob, { binary: true });
        } catch(e) {
            console.error(`Failed to repack nested archive ${archiveName}. Skipping.`, e);
        }
    }
    return zip;
};

// --- VIEW COMPONENTS ---

const HeaderInfo: React.FC<{
    usageCount: number;
    hasUnlimited: boolean;
    userId: string;
    setView: (view: View) => void;
    isOwner: boolean;
    isDevMode: boolean;
    toggleDevMode: () => void;
}> = ({ usageCount, hasUnlimited, userId, setView, isOwner, isDevMode, toggleDevMode }) => {
    const remainingAttempts = USAGE_LIMIT - usageCount;
    const getUsageColor = (count: number) => {
        if (count <= 1) return 'text-red-400';
        if (count <= 3) return 'text-yellow-400';
        return 'text-green-400';
    };
    
    const usageColor = hasUnlimited ? 'text-green-400' : getUsageColor(remainingAttempts);

    const usageCountDisplay = hasUnlimited ? '∞' : Math.max(0, remainingAttempts);

    return (
        <div className="w-full flex justify-between items-center gap-4 text-sm mb-6 bg-gray-900/40 p-3 rounded-2xl border border-gray-800/60 shadow-sm backdrop-blur-sm animate-fade-in relative z-20">
            {/* Left side: Attempts */}
            <div className="flex items-center gap-3">
                <div className="bg-gray-950/60 px-3 py-1.5 rounded-lg flex items-center gap-2 border border-gray-800/50 hover:border-gray-700/80 transition-colors">
                    <span className="text-gray-400 font-medium">Спроби:</span>
                    <span className={`font-black text-base drop-shadow-sm ${usageColor}`}>
                        {usageCountDisplay}
                    </span>
                    <button onClick={() => setView('unlimited')} className="text-gray-500 hover:text-white transition-all transform hover:scale-110 cursor-pointer p-0.5 ml-1" title="Отримати більше спроб">
                       <PlusIcon className="w-4 h-4" />
                    </button>
                </div>
            </div>
            
            {/* Right side: User ID */}
            <div className="bg-gray-950/60 px-3 py-1.5 rounded-lg flex items-center gap-2 border border-gray-800/50 hover:border-gray-700/80 transition-colors overflow-hidden">
                <span className="text-gray-400 font-medium hidden sm:inline">Ваш ID: </span>
                <span className="font-mono text-gray-200 truncate font-semibold w-20 sm:w-auto text-right">{userId}</span>
                <CopyButton textToCopy={userId} />
            </div>
        </div>
    );
};


const InstructionSection: React.FC<{
    planName: string;
    price: string;
    userId: string;
    tgNickname: string;
    setTgNickname: (val: string) => void;
    receiptFiles: { name: string; size: number; data: string }[];
    handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    handleRemoveFile: (index: number) => void;
    handleDragOver: (e: React.DragEvent) => void;
    handleDrop: (e: React.DragEvent) => void;
    handleSendRequest: () => void;
    isSubmitting: boolean;
    error: string;
}> = ({
    planName,
    price,
    userId,
    tgNickname,
    setTgNickname,
    receiptFiles,
    handleFileChange,
    handleRemoveFile,
    handleDragOver,
    handleDrop,
    handleSendRequest,
    isSubmitting,
    error
}) => {
    return (
        <div className="space-y-4 bg-gray-950/20 border border-gray-800/80 p-5 rounded-xl text-xs md:text-sm leading-relaxed text-gray-300">
            <div className="space-y-2">
                <p className="font-bold text-white text-sm">Спосіб Оплати:</p>
                <div className="bg-gray-900/60 p-3.5 rounded-lg border border-gray-800 flex flex-col space-y-2">
                    <p className="text-xs">
                        Будь ласка, здійсніть переказ <strong className="text-yellow-400 font-extrabold">{price}</strong> на офіційну банку Monobank:
                    </p>
                    <a href={SECRETS.monobankUrl} target="_blank" rel="noopener noreferrer" className="block text-center bg-[#ea5455] hover:bg-[#e73939] text-white font-bold py-2 px-4 rounded-xl transition-all shadow-md active:scale-95 text-xs tracking-wider">
                        Натисніть для переходу до Monobank
                    </a>
                    <p className="text-[10px] text-gray-500 mt-2 text-center">
                        Призначення платежу (необов'язково): <code className="text-teal-400 border border-teal-900/40 px-1 py-0.5 rounded font-mono font-bold select-all">{userId}</code>
                    </p>
                </div>
            </div>

            <div className="space-y-2">
                <label className="block text-xs font-bold text-gray-200">
                    Ваш Telegram нікнейм (для зв'язку за потреби):
                </label>
                <div className="relative">
                    <span className="absolute left-3 top-2.5 text-gray-500 font-bold">@</span>
                    <input 
                        type="text" 
                        value={tgNickname.replace(/^@/, '')} 
                        onChange={(e) => setTgNickname(e.target.value.trim())} 
                        placeholder="telegram_username"
                        className="w-full bg-gray-900 border border-gray-750/80 rounded-xl p-2.5 pl-7 text-xs text-white focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary placeholder:text-gray-650"
                    />
                </div>
            </div>

            <div className="space-y-2">
                <label className="block text-xs font-bold text-gray-200">
                    Квитанція / Скріншот оплати (від 1 до 3 файлів):
                </label>
                
                <div 
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                    className="border-2 border-dashed border-gray-700 hover:border-brand-primary/50 bg-gray-900/40 rounded-xl p-4 text-center cursor-pointer transition-colors relative"
                >
                    <input 
                        type="file" 
                        id={`file-upload-${planName}`} 
                        multiple 
                        accept="image/*" 
                        className="hidden" 
                        onChange={handleFileChange} 
                    />
                    <label htmlFor={`file-upload-${planName}`} className="cursor-pointer space-y-1 block">
                        <UploadIcon className="w-8 h-8 text-gray-500 mx-auto" />
                        <p className="text-xs text-gray-300 font-medium">Перетягніть скріншоти сюди або <span className="text-brand-primary hover:underline font-bold">натисніть для вибору</span></p>
                        <p className="text-[10px] text-gray-500">Дозволено додавати тільки зображення (.png, .jpeg, .jpg), макс. 3 файли</p>
                    </label>
                </div>

                {receiptFiles.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                        <p className="text-[10px] font-bold text-teal-400 uppercase tracking-wider">Завантажені скріншоти ({receiptFiles.length}/3):</p>
                        <div className="space-y-1 max-h-32 overflow-y-auto custom-scrollbar">
                            {receiptFiles.map((file, idx) => (
                                <div key={idx} className="flex items-center justify-between bg-gray-900 border border-gray-850 rounded-lg p-2 text-xs">
                                    <div className="flex items-center space-x-2 truncate">
                                        <div className="w-6 h-6 rounded bg-gray-800 border border-gray-700 overflow-hidden flex-shrink-0 flex items-center justify-center">
                                            <img src={file.data} alt="receipt" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                        </div>
                                        <span className="text-gray-300 truncate max-w-[180px] font-mono text-[10px]">{file.name}</span>
                                    </div>
                                    <div className="flex items-center space-x-2">
                                        <span className="text-[9px] text-gray-550 font-mono">{(file.size / 1024).toFixed(1)} KB</span>
                                        <button 
                                            type="button"
                                            onClick={() => handleRemoveFile(idx)}
                                            className="text-red-400 hover:text-red-300 p-1 rounded hover:bg-gray-800 transition-colors"
                                            title="Видалити"
                                        >
                                            <TrashIcon className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {error && (
                <div className="p-3 bg-red-950/40 border border-red-800/50 rounded-xl text-red-300 text-xs text-left font-sans flex items-start gap-2">
                    <ErrorIcon className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-400" />
                    <span>{error}</span>
                </div>
            )}

            <button 
                type="button"
                onClick={handleSendRequest}
                disabled={isSubmitting || receiptFiles.length === 0 || receiptFiles.length > 3 || tgNickname.trim() === ''}
                className="w-full bg-brand-primary hover:bg-brand-secondary text-white font-bold py-3 px-4 rounded-xl transition-all shadow-md active:scale-95 text-xs uppercase cursor-pointer flex items-center justify-center space-x-2 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed"
            >
                {isSubmitting ? (
                    <>
                        <SpinnerIcon className="w-4 h-4 animate-spin" />
                        <span>Відправка...</span>
                    </>
                ) : (
                    <span>Надіслати заявку на перевірку </span>
                )}
            </button>
        </div>
    );
};

interface DBUser {
    userId?: string;
    id?: string;
    telegramNick?: string;
    telegramUsername?: string;
    nick?: string;
    status?: string;
    screen1?: string;
    screen2?: string;
    screen3?: string;
}

// Старий формат Google Drive «uc?export=view&id=...» більше НЕ віддає зображення
// у тег <img> (Google повертає HTML-сторінку замість картинки) — саме тому
// скріншоти не відображалися в адмінці. Перетворюємо будь-яке Drive-посилання на
// надійний thumbnail-формат, який коректно вбудовується через <img>.
const toDisplayableDriveUrl = (url?: string): string => {
    if (!url) return '';
    if (!/drive\.google\.com/.test(url)) return url;
    if (/drive\.google\.com\/thumbnail/.test(url)) return url; // вже коректний
    const m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/) || url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (m && m[1]) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1600`;
    return url;
};

const CloseIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
);

const ExpandIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
    </svg>
);

const RefreshIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
);

const AdminControlPanel: React.FC<{ 
    setView?: (v: View) => void;
    isDevMode: boolean;
    toggleDevMode: () => void;
}> = ({ setView, isDevMode, toggleDevMode }) => {
    const [usersList, setUsersList] = useState<DBUser[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');
    const [actionStatus, setActionStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);
    const [giveAmounts, setGiveAmounts] = useState<Record<string, number>>({});
    const [lightboxImg, setLightboxImg] = useState<string | null>(null);
    const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

    const fetchAllUsers = async () => {
        setIsLoading(true);
        setErrorMsg('');
        try {
            const params = new URLSearchParams({ action: "getAll", token: SECRETS.secretToken });
            const response = await fetch(`${SECRETS.scriptUrl}?${params.toString()}`);
            if (response.ok) {
                const text = await response.text();
                let data: any = [];
                try {
                    data = JSON.parse(text);
                } catch {
                    // ignore parse failures
                }
                if (Array.isArray(data)) {
                    setUsersList(data);
                } else if (data && typeof data === 'object' && Array.isArray(data.users)) {
                    setUsersList(data.users);
                } else {
                    setErrorMsg("Невірний формат відповіді від сервера.");
                }
            } else {
                setErrorMsg("Сервер відхилив запит.");
            }
        } catch (err: any) {
            setErrorMsg(err.message || "Помилка зв'язку з сервером.");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchAllUsers();
    }, []);

    const handleUpdateStatus = async (targetUserId: string, status: string) => {
        try {
            const params = new URLSearchParams({
                action: "updateStatus",
                token: SECRETS.secretToken,
                userId: targetUserId,
                newStatus: status
            });
            const response = await fetch(`${SECRETS.scriptUrl}?${params.toString()}`);
            if (response.ok) {
                setUsersList(prev => prev.filter(u => (u.userId || u.id) !== targetUserId));
                setActionStatus({ type: 'success', message: `Статус успішно змінено.` });
                setSelectedUserId(null); // return to list
                setTimeout(() => setActionStatus(null), 3000);
            } else {
                setActionStatus({ type: 'error', message: "Помилка при оновленні статусу." });
                setTimeout(() => setActionStatus(null), 3000);
            }
        } catch (err: any) {
            setActionStatus({ type: 'error', message: "Помилка зв'язку." });
            setTimeout(() => setActionStatus(null), 3000);
        }
    };

    const pendingUsers = usersList.filter(u => u.status?.toLowerCase() === 'pending');
    
    const downloadImage = async (rawUrl: string, prefix: string) => {
        const url = toDisplayableDriveUrl(rawUrl);
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = `receipt_${prefix}_${Date.now()}.jpg`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        } catch (err) {
            const a = document.createElement('a');
            a.href = url;
            a.download = `receipt_${prefix}_${Date.now()}.jpg`;
            a.target = '_blank';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    };

    if (selectedUserId) {
        const u = pendingUsers.find(user => (user.userId || user.id) === selectedUserId);
        if (!u) {
            setSelectedUserId(null);
            return null;
        }

        const uid = u.userId || u.id || 'UnknownID';
        const nick = u.telegramNick || u.nick || u.telegramUsername || 'Без ніку';
        const activeGiveVal = giveAmounts[uid] || 5;

        return (
            <div className="flex flex-col h-full bg-[#0a0c16] text-gray-200 p-4 md:p-8 animate-fade-in absolute inset-0 z-50 overflow-y-auto">
                <div className="max-w-4xl w-full mx-auto space-y-6 pt-4">
                    <button 
                        onClick={() => setSelectedUserId(null)}
                        className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
                    >
                        <BackIcon className="w-5 h-5"/>
                        <span className="font-medium text-sm">Назад до списку заявок</span>
                    </button>

                    <div className="bg-[#15192b] border border-gray-800 rounded-2xl p-6 md:p-8 space-y-8 shadow-2xl">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-800/60 pb-6">
                            <div>
                                <h1 className="text-2xl font-bold text-white">Користувач: @{nick}</h1>
                                <p className="text-xs font-mono text-gray-500 mt-1 select-all">ID: {uid}</p>
                            </div>
                            <div className="bg-purple-600/20 text-purple-400 px-4 py-2 rounded-lg font-medium text-sm border border-purple-500/30">
                                Очікує на перевірку
                            </div>
                        </div>

                        {(u.screen1 || u.screen2 || u.screen3) ? (
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                {[u.screen1, u.screen2, u.screen3].filter(Boolean).map((src, i) => (
                                    <div key={i} className="flex flex-col gap-3">
                                        <div 
                                            className="aspect-[3/4] rounded-xl border border-gray-700/50 overflow-hidden bg-black/50 cursor-pointer relative shadow-lg group"
                                            onClick={() => setLightboxImg(src)}
                                        >
                                            <img src={toDisplayableDriveUrl(src)} alt="Screenshot thumbnail" loading="lazy" referrerPolicy="no-referrer" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col items-center justify-center">
                                                <ExpandIcon className="w-8 h-8 text-white drop-shadow-md mb-2" />
                                                <span className="text-white text-xs font-medium">Переглянути</span>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="p-10 border border-dashed border-gray-700 rounded-xl flex items-center justify-center text-gray-500">
                                Скріншоти відсутні
                            </div>
                        )}

                        <div className="border-t border-gray-800/60 pt-6 space-y-6">
                            <h3 className="text-xl font-bold text-white">Дії над заявкою</h3>
                            
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                <button
                                    type="button"
                                    onClick={() => handleUpdateStatus(uid, 'approved_5')}
                                    className="bg-green-600 hover:bg-green-500 text-white font-bold py-4 rounded-xl text-sm transition-all shadow-lg hover:shadow-green-900/50"
                                >
                                    Схвалити +5 спроб
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleUpdateStatus(uid, 'approved_unlim')}
                                    className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 rounded-xl text-sm transition-all shadow-lg hover:shadow-blue-900/50"
                                >
                                    Надати Безліміт
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleUpdateStatus(uid, 'rejected')}
                                    className="bg-red-900/80 hover:bg-red-800 text-white font-bold py-4 rounded-xl text-sm transition-all shadow-lg hover:shadow-red-900/20"
                                >
                                    Відхилити заявку
                                </button>
                            </div>

                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-black/40 p-4 rounded-xl border border-gray-800/50">
                                <div className="flex items-center gap-3 justify-between sm:justify-start w-full sm:w-auto">
                                    <span className="text-sm font-medium text-gray-400">Кастомне нарахування:</span>
                                    <input
                                        type="number"
                                        value={activeGiveVal}
                                        onChange={(e) => {
                                            const val = Math.max(1, parseInt(e.target.value, 10) || 1);
                                            setGiveAmounts(prev => ({ ...prev, [uid]: val }));
                                        }}
                                        className="w-20 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-center text-sm text-gray-200 focus:outline-none focus:border-purple-500 transition-colors"
                                    />
                                </div>
                                <div className="flex flex-col sm:flex-row gap-2.5 w-full sm:w-auto">
                                    <button
                                        type="button"
                                        onClick={() => handleUpdateStatus(uid, `give_${activeGiveVal}`)}
                                        className="w-full sm:w-auto bg-purple-600/20 hover:bg-purple-600/40 border border-purple-500/30 text-purple-300 font-medium px-4 py-2.5 rounded-lg text-sm transition-colors whitespace-nowrap text-center"
                                    >
                                        Нарахувати {activeGiveVal}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleUpdateStatus(uid, `take_${activeGiveVal}`)}
                                        className="w-full sm:w-auto bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 font-medium px-4 py-2.5 rounded-lg text-sm transition-colors whitespace-nowrap text-center"
                                    >
                                        Відняти {activeGiveVal}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Lightbox for detail view */}
                {lightboxImg && (
                    <div 
                        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-md p-4"
                        onClick={() => setLightboxImg(null)}
                    >
                        <div className="relative w-full h-full flex flex-col items-center justify-center">
                            <button 
                                className="absolute top-6 right-6 bg-gray-800/80 text-white p-3 rounded-full hover:bg-gray-700 transition-transform hover:scale-110 z-[101]"
                                onClick={(e) => { e.stopPropagation(); setLightboxImg(null); }}
                                aria-label="Close fullscreen"
                            >
                                <CloseIcon className="w-6 h-6" />
                            </button>
                            <img
                                src={toDisplayableDriveUrl(lightboxImg)}
                                alt="Fullscreen Screenshot"
                                referrerPolicy="no-referrer"
                                className="max-w-full max-h-[90vh] object-contain rounded-xl shadow-[0_0_50px_rgba(0,0,0,0.8)]"
                                onClick={e => e.stopPropagation()}
                            />
                            <button 
                                onClick={(e) => { e.stopPropagation(); downloadImage(lightboxImg, "fullscreen"); }}
                                className="absolute bottom-6 bg-purple-600 hover:bg-purple-500 text-white px-6 py-3 rounded-full font-bold shadow-lg transition-transform hover:scale-105"
                            >
                                Завантажити скріншот
                            </button>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="w-full max-w-5xl mx-auto flex flex-col h-full space-y-6 font-sans py-4 px-2 sm:px-0">
            <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-800 pb-4">
                <div>
                    <h1 className="text-3xl font-black text-white tracking-tight">Адмін-панель</h1>
                    <p className="text-gray-400 text-sm mt-1">Очікують на перевірку: {pendingUsers.length}</p>
                </div>
                <div className="grid grid-cols-2 sm:flex sm:items-center gap-3 w-full sm:w-auto">
                    <button
                        onClick={fetchAllUsers}
                        className="w-full sm:w-auto flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-750 px-4 py-2.5 rounded-xl font-medium transition-colors cursor-pointer"
                        disabled={isLoading}
                    >
                        <RefreshIcon className={`w-4 h-4 ${isLoading ? 'animate-spin text-purple-400' : ''}`} />
                        <span>Оновити</span>
                    </button>
                    <button
                        onClick={toggleDevMode}
                        className={`w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-medium transition-all border cursor-pointer ${
                            isDevMode 
                                ? 'bg-purple-600/20 text-purple-300 border-purple-500/40 hover:bg-purple-600/30' 
                                : 'bg-gray-800 hover:bg-gray-700 text-gray-450 border-gray-750'
                        }`}
                    >
                        <span>{isDevMode ? '🛠️ Dev Mode: Так' : '🛠️ Dev Mode: Ні'}</span>
                    </button>
                </div>
            </header>

            {actionStatus && (
                <div className={`p-4 rounded-xl text-sm font-medium flex items-center gap-3 border animate-fade-in ${
                    actionStatus.type === 'success' 
                        ? 'bg-green-950/40 border-green-800/40 text-green-400' 
                        : 'bg-red-950/40 border-red-800/40 text-red-400'
                }`}>
                    {actionStatus.type === 'success' ? <CheckIcon className="w-5 h-5" /> : <ErrorIcon className="w-5 h-5" />}
                    <span>{actionStatus.message}</span>
                </div>
            )}

            {errorMsg && (
                <p className="text-red-400 text-sm font-medium bg-red-950/30 border border-red-900/50 p-4 rounded-xl">{errorMsg}</p>
            )}

            <main className="bg-[#101322] border border-gray-800 rounded-2xl p-2 md:p-4 min-h-[400px]">
                {isLoading && usersList.length === 0 ? (
                    <div className="py-20 flex flex-col items-center gap-4">
                        <SpinnerIcon className="w-8 h-8 animate-spin text-purple-500" />
                        <span className="text-sm text-gray-400 tracking-wide">Завантаження заявок...</span>
                    </div>
                ) : pendingUsers.length === 0 ? (
                    <div className="py-20 flex flex-col items-center justify-center text-center">
                        <span className="text-6xl mb-4 opacity-50">🎉</span>
                        <h3 className="text-xl font-bold text-gray-300">Немає нових заявок</h3>
                        <p className="text-gray-500 text-sm mt-2">Ви перевірили всі запити від користувачів.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {pendingUsers.map((u, index) => {
                            const uid = u.userId || u.id || 'UnknownID';
                            const nick = u.telegramNick || u.nick || u.telegramUsername || 'Без ніку';
                            
                            return (
                                <div 
                                    key={index} 
                                    onClick={() => setSelectedUserId(uid)}
                                    className="bg-[#161a2b] border border-gray-800 hover:border-purple-500/50 rounded-xl p-5 cursor-pointer group transition-all duration-300 hover:shadow-lg hover:shadow-purple-900/10 flex flex-col"
                                >
                                    <div className="flex items-start justify-between mb-4">
                                        <div>
                                            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Користувач</p>
                                            <p className="text-lg font-bold text-gray-100 truncate group-hover:text-purple-300 transition-colors">@{nick}</p>
                                        </div>
                                        <div className="bg-purple-900/30 p-2 rounded-lg text-purple-400 group-hover:bg-purple-600 group-hover:text-white transition-colors">
                                            <ExpandIcon className="w-5 h-5"/>
                                        </div>
                                    </div>
                                    
                                    <div className="mt-auto">
                                        <p className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold">ID Заявки</p>
                                        <p className="text-xs font-mono text-gray-400 truncate">{uid}</p>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </main>

            {setView && (
                <footer className="pt-6 border-t border-gray-800/80">
                    <button 
                        onClick={() => setView('menu')} 
                        className="w-full flex items-center justify-center gap-2 bg-[#1c223c] hover:bg-[#252d4f] border border-purple-500/30 text-purple-300 font-bold py-3.5 px-4 rounded-xl transition-all duration-350 cursor-pointer"
                    >
                        <BackIcon className="w-5 h-5"/>
                        Назад до Головного Меню
                    </button>
                </footer>
            )}
        </div>
    );
};

const MainMenu: React.FC<{ 
    setView: (view: View) => void; 
    usageCount: number; 
    hasUnlimited: boolean; 
    autoStatus: TranslationState;
    apiStatus: TranslationState;
    setShowBuyAttemptsModal: (val: boolean) => void;
    isOwner: boolean;
    isDevMode: boolean;
    toggleDevMode: () => void;
}> = ({ setView, usageCount, hasUnlimited, autoStatus, apiStatus, setShowBuyAttemptsModal, isOwner, isDevMode, toggleDevMode }) => {
    const remainingAttempts = USAGE_LIMIT - usageCount;
    const isLimitReached = remainingAttempts <= 0 && !hasUnlimited;

    const StatusIndicator: React.FC<{ status: TranslationState, color: string }> = ({ status, color }) => {
        if (status.processingState === ProcessingState.IDLE) return null;

        const baseClasses = "absolute top-2 right-2 text-xs font-bold text-white px-2.5 py-1 rounded-full flex items-center gap-1 shadow-md z-10 font-sans";
        
        if (status.processingState === ProcessingState.PROCESSING) {
            return (
                <div className={`${baseClasses} bg-blue-600`}>
                    <SpinnerIcon className="w-3 h-3"/>
                    <span>{formatTime(status.elapsedTime)}</span>
                </div>
            )
        }
        if (status.processingState === ProcessingState.DONE) {
             return (
                <div className={`${baseClasses} bg-green-600`}>
                    <CheckIcon className="w-3 h-3"/>
                    <span>{formatTime(status.elapsedTime)}</span>
                </div>
            )
        }
        return null;
    }

    const OptionButton: React.FC<{
        onClick: () => void;
        icon: React.ReactNode;
        title: string;
        description: string;
        disabled?: boolean;
        disabledText?: string;
        status?: TranslationState;
        hoverBorderClass?: string;
        gradientHover?: string;
    }> = ({ onClick, icon, title, description, disabled, disabledText, status, hoverBorderClass = 'hover:border-brand-primary', gradientHover = 'group-hover:from-brand-primary/10 group-hover:to-transparent' }) => {
        const [showHelp, setShowHelp] = useState(false);

        return (
            <div
                onClick={() => {
                    if (!disabled) onClick();
                }}
                className={`relative flex flex-col items-center justify-center p-6 sm:p-8 bg-[#161a2b] bg-gradient-to-br from-transparent to-transparent ${gradientHover} shadow-xl hover:shadow-2xl border-2 border-gray-700/40 rounded-2xl transition-all duration-300 min-h-[220px] cursor-pointer group select-none text-center overflow-hidden ${
                    disabled 
                        ? 'opacity-50 cursor-not-allowed border-gray-800' 
                        : `hover:scale-[1.01] active:scale-[0.99] ${hoverBorderClass}`
                }`}
            >
                {status && <StatusIndicator status={status} color={hoverBorderClass}/>}
                
                <button 
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        setShowHelp(!showHelp);
                    }}
                    className="absolute bottom-4 right-4 p-1.5 rounded-full bg-gray-900/60 border border-gray-700 hover:border-teal-400 text-gray-400 hover:text-white transition-all cursor-pointer z-20 backdrop-blur-md"
                    title="Показати довідку"
                >
                    <InfoIcon className="w-5 h-5" />
                </button>

                <div className="flex flex-col items-center w-full space-y-5 z-10">
                    <div className="p-4 bg-gray-900/60 rounded-full transition-transform duration-300 group-hover:scale-110 group-hover:bg-gray-800/80 shadow-inner border border-gray-800/50">
                        {icon}
                    </div>
                    
                    <div className="space-y-1.5 text-center px-4">
                        <h2 className="text-xl sm:text-2xl font-extrabold text-gray-100 tracking-tight group-hover:text-white transition-colors font-sans">
                            {title}
                        </h2>
                        {disabled && disabledText && (
                            <p className="text-xs font-bold text-red-400 uppercase tracking-widest pt-1 drop-shadow-sm font-sans">
                                {disabledText}
                            </p>
                        )}
                    </div>

                    {showHelp && (
                        <div className="absolute inset-0 bg-[#0d111c]/95 flex items-center justify-center p-6 animate-fade-in z-30 backdrop-blur-sm">
                            <p className="text-gray-200 text-center text-sm sm:text-base leading-relaxed font-medium font-sans">
                                {description}
                            </p>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="w-full flex flex-col items-center space-y-8 animate-fade-in font-sans">
            <header className="text-center space-y-3">
                <h1 className="text-3xl sm:text-4xl md:text-5xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white via-gray-200 to-gray-500 tracking-tight leading-tight select-none drop-shadow-lg">
                    Перекладач Аддонів
                </h1>
                <p className="text-sm sm:text-base md:text-lg text-gray-400 font-medium tracking-wide">
                    Миттєво перекладайте ваші доповнення українською
                </p>
            </header>

            <main className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 w-full max-w-5xl mx-auto">
                {isOwner && (
                    <div className="md:col-span-2">
                        <OptionButton 
                            onClick={() => setView('admin')} 
                            icon={<span className="text-4xl drop-shadow-[0_0_15px_rgba(59,130,246,0.4)]">🔒</span>} 
                            title="Меню для розробника" 
                            description="Панель керування заявами на розблокування безліміту та поповнення спроб. Перевіряйте чеки з monobank та схвалюйте або відхиляйте запити."
                            hoverBorderClass="hover:border-blue-500/70"
                            gradientHover="group-hover:from-blue-900/10 group-hover:to-transparent"
                        />
                    </div>
                )}

                <OptionButton 
                    onClick={() => {
                        if (isLimitReached && autoStatus.processingState === ProcessingState.IDLE) {
                            setShowBuyAttemptsModal(true);
                        } else {
                            setView('auto');
                        }
                    }} 
                    icon={<SparklesIcon className="w-12 h-12 text-purple-400 drop-shadow-[0_0_15px_rgba(168,85,247,0.4)]" />} 
                    title="Автоматичний Переклад" 
                    description="Найпростіший спосіб для швидкого результату. Завантажте ваш аддон, і наш безкоштовний сервіс автоматично перекладе його. Идеально для невеликих файлів. Має денні ліміти використання."
                    disabled={false}
                    disabledText={isLimitReached && autoStatus.processingState === ProcessingState.IDLE ? "Спроби вичерпано" : undefined}
                    status={autoStatus}
                    hoverBorderClass="hover:border-purple-500/70"
                    gradientHover="group-hover:from-purple-900/10 group-hover:to-transparent"
                />
                
                <OptionButton 
                    onClick={() => {
                        if (isLimitReached && apiStatus.processingState === ProcessingState.IDLE) {
                            setShowBuyAttemptsModal(true);
                        } else {
                            setView('auto_with_api');
                        }
                    }} 
                    icon={<KeyIcon className="w-12 h-12 text-teal-400 drop-shadow-[0_0_15px_rgba(45,212,191,0.4)]" />} 
                    title="Переклад з API-ключем" 
                    description="Використовуйте власний ключ Google Gemini API для перекладу без обмежень та лімітів. Максимальна швидкість та контроль. Ідеально підходить для великих аддонів та частих перекладів."
                    disabled={false}
                    disabledText={isLimitReached && apiStatus.processingState === ProcessingState.IDLE ? "Спроби вичерпано" : undefined}
                    status={apiStatus}
                    hoverBorderClass="hover:border-teal-500/70"
                    gradientHover="group-hover:from-teal-900/10 group-hover:to-transparent"
                />
                
                <div className="md:col-span-2">
                    <OptionButton 
                        onClick={() => {
                            if (isLimitReached) {
                                setShowBuyAttemptsModal(true);
                            } else {
                                setView('manual');
                            }
                        }} 
                        icon={<ManualIcon className="w-12 h-12 text-amber-400 drop-shadow-[0_0_15px_rgba(251,191,36,0.4)]" />} 
                        title="Ручний Переклад" 
                        description="Для просунутих користувачів. Програма витягне всі тексти з аддону, ви самостійно перекладете їх у будь-конкретному сторонньому сервісі або ШІ, а потім програма запакує їх назад."
                        disabled={false}
                        disabledText={isLimitReached ? "Спроби вичерпано" : undefined}
                        hoverBorderClass="hover:border-amber-500/70"
                        gradientHover="group-hover:from-amber-900/10 group-hover:to-transparent"
                    />
                </div>
            </main>
        </div>
    );
};


const UnlimitedAccessView: React.FC<{ 
    setView: (view: View) => void; 
    onActivate: (code: string) => 'unlimited' | 'attempts_added' | 'invalid' | 'promo_used' | 'api_key_entered';
    userId: string; 
    isDevMode: boolean;
    isOwner?: boolean;
    specialView?: boolean;
    onToggleDevMode: () => void;
    onProvision: (key: string) => void;
    onStartPolling?: () => void;
}> = ({ setView, onActivate, userId, isDevMode, isOwner, specialView, onToggleDevMode, onProvision, onStartPolling }) => {
    const isSystemOwner = isOwner || specialView;
    const [code, setCode] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [generatedKey, setGeneratedKey] = useState('');

    // Persistence states
    const [selectedPlan, setSelectedPlan] = useState<'attempts' | 'unlimited' | null>(() => {
        const val = localStorage.getItem('mc_payment_selected_plan');
        return (val === 'attempts' || val === 'unlimited') ? val : null;
    });
    
    const [tgNickname, setTgNickname] = useState(() => {
        return localStorage.getItem('mc_payment_tg_nickname') || '';
    });

    const [receiptFiles, setReceiptFiles] = useState<{name: string, size: number, data: string}[]>(() => {
        try {
            const val = localStorage.getItem('mc_payment_receipts');
            return val ? JSON.parse(val) : [];
        } catch {
            return [];
        }
    });

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isSubmitted, setIsSubmitted] = useState(false);

    useEffect(() => {
        if (selectedPlan) {
            localStorage.setItem('mc_payment_selected_plan', selectedPlan);
            localStorage.setItem('mc_payment_active', 'true');
        } else {
            localStorage.removeItem('mc_payment_selected_plan');
        }
    }, [selectedPlan]);

    useEffect(() => {
        localStorage.setItem('mc_payment_tg_nickname', tgNickname);
        if (tgNickname.trim() !== '') {
            localStorage.setItem('mc_payment_active', 'true');
        }
    }, [tgNickname]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files) return;
        addFiles(Array.from(files));
        localStorage.setItem('mc_payment_active', 'true');
    };

    const addFiles = async (filesList: File[]) => {
        const compressImage = (file: File, maxWidth = 1000, maxHeight = 1000, quality = 0.7): Promise<string> => {
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        let width = img.width;
                        let height = img.height;

                        if (width > height) {
                            if (width > maxWidth) {
                                height = Math.round((height * maxWidth) / width);
                                width = maxWidth;
                            }
                        } else {
                            if (height > maxHeight) {
                                width = Math.round((width * maxHeight) / height);
                                height = maxHeight;
                            }
                        }

                        canvas.width = width;
                        canvas.height = height;

                        const ctx = canvas.getContext('2d');
                        if (ctx) {
                            ctx.drawImage(img, 0, 0, width, height);
                            resolve(canvas.toDataURL('image/jpeg', quality));
                        } else {
                            resolve(e.target?.result as string);
                        }
                    };
                    img.onerror = () => {
                        resolve(e.target?.result as string);
                    };
                    img.src = e.target?.result as string;
                };
                reader.readAsDataURL(file);
            });
        };

        const filesToProcess = filesList.slice(0, 3);
        const base64Array = await Promise.all(filesToProcess.map(compressImage));

        setReceiptFiles(prev => {
            const updated = [...prev];
            filesToProcess.forEach((file, idx) => {
                updated.push({
                    name: file.name,
                    size: file.size,
                    data: base64Array[idx]
                });
            });
            const finalUpdated = updated.slice(0, 3);
            localStorage.setItem('mc_payment_receipts', JSON.stringify(finalUpdated));
            return finalUpdated;
        });
    };

    const handleRemoveFile = (index: number) => {
        setReceiptFiles(prev => {
            const updated = prev.filter((_, i) => i !== index);
            localStorage.setItem('mc_payment_receipts', JSON.stringify(updated));
            return updated;
        });
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const files = e.dataTransfer?.files;
        if (files) {
            addFiles(Array.from(files));
            localStorage.setItem('mc_payment_active', 'true');
        }
    };

    const handleClose = () => {
        localStorage.setItem('mc_payment_active', 'false');
        setView('menu');
    };

    const handleSendRequest = async () => {
        if (!selectedPlan) {
            setError('Будь ласка, оберіть тарифний план.');
            return;
        }
        if (tgNickname.trim() === '') {
            setError('Введіть ваш Telegram нікнейм.');
            return;
        }
        if (receiptFiles.length === 0) {
            setError('Завантажте хоча б один скріншот або квитанцію.');
            return;
        }

        setIsSubmitting(true);
        setError('');

        try {
            const screenshots = receiptFiles.map(r => r.data).slice(0, 3);
            const payload = {
                action: "create",
                userId: userId,
                telegramNick: tgNickname,
                screenshot1: screenshots[0] || "",
                screenshot2: screenshots[1] || "",
                screenshot3: screenshots[2] || "",
                screenshots: screenshots
            };

            try {
                await fetch(SECRETS.scriptUrl, {
                    method: "POST",
                    mode: "no-cors",
                    headers: {
                        "Content-Type": "text/plain;charset=utf-8"
                    },
                    body: JSON.stringify(payload)
                });
            } catch (err) {
                console.error("POST failed, trying GET fallback...", err);
                const fallbackParams = new URLSearchParams({
                    action: "create",
                    userId: userId,
                    telegramNick: tgNickname,
                    isFallback: "true"
                });
                
                await fetch(`${SECRETS.scriptUrl}?${fallbackParams.toString()}`, { method: 'GET' }).catch(console.error);
            }

            setIsSubmitted(true);
            
            localStorage.setItem('mc_payment_polling_active', 'true');
            if (onStartPolling) {
                onStartPolling();
            }

            localStorage.removeItem('mc_payment_selected_plan');
            localStorage.removeItem('mc_payment_tg_nickname');
            localStorage.removeItem('mc_payment_receipts');
            localStorage.setItem('mc_payment_active', 'false');
            
            setSelectedPlan(null);
            setTgNickname('');
            setReceiptFiles([]);
        } catch (err: any) {
            setError('Сталася помилка при відправці заявки: ' + (err.message || 'Спробуйте ще раз.'));
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleSubmitCode = () => {
        const result = onActivate(code);
        if (result === 'unlimited') {
            setError('');
            setSuccess('Успіх! Необмежений доступ активовано.');
            setTimeout(() => setView('menu'), 2000);
        } else if (result === 'attempts_added') {
            setError('');
            setSuccess('Успіх! Вам додано 5 спроб.');
            setTimeout(() => setView('menu'), 2000);
        } else if (result === 'promo_used') {
            setError('Цей промокод вже було використано.');
            setSuccess('');
        } else if (result === 'api_key_entered') {
            setError('Це Google API ключ, а не код доступу. Будь ласка, вкажіть його у розділі "Переклад з API-ключем".');
            setSuccess('');
        } else {
            setError('Невірний або вже використаний код активації.');
            setSuccess('');
        }
    };
    
    if (isSubmitted) {
        return (
            <div className="w-full flex flex-col h-full space-y-6 text-center py-6 animate-fade-in max-w-lg mx-auto">
                <div className="p-5 bg-green-950/40 border-2 border-green-800/40 rounded-2xl space-y-4 shadow-xl">
                    <CheckIcon className="w-16 h-16 text-green-400 mx-auto animate-bounce" />
                    <h2 className="text-2xl font-black text-white font-sans">Заявку надіслано!</h2>
                    <p className="text-gray-300 text-sm leading-relaxed text-left font-sans">
                        Вашу заявку на перевірку платежу успішно надіслано адміністратору. <br/><br/>
                        ⏳ <strong>Час очікування перевірки:</strong> зазвичай триває від 10 до 30 хвилин. <br/><br/>
                        Після перевірки ваш рахунок буде поповнено автоматично, або адміністратор зв'яжеться з вами в Telegram.
                    </p>
                    <button 
                        onClick={() => {
                            setIsSubmitted(false);
                            setView('menu');
                        }}
                        className="w-full bg-brand-primary hover:bg-brand-secondary text-white font-bold py-3 px-4 rounded-xl transition-all cursor-pointer shadow-md text-sm font-sans"
                    >
                        Повернутись до Головного Меню
                    </button>
                </div>
            </div>
        );
    }
    
    return (
        <div className="w-full flex flex-col h-full space-y-6 animate-fade-in max-w-2xl mx-auto">
            <header className="text-center space-y-2">
                <div className="inline-block bg-brand-primary/10 border border-brand-primary/25 text-brand-primary px-4 py-1 rounded-full text-xs font-bold uppercase tracking-wider select-none font-sans">
                    Поповнення Спроб
                </div>
                <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white font-sans">Вибір Тарифного Плану</h1>
                <p className="text-sm text-gray-400 max-w-md mx-auto font-sans">Оберіть варіант поповнення. Оплата здійснюється на Monobank з ручною перевіркою адміном.</p>
            </header>

            <main className="flex-grow space-y-6 text-left">
                 {isSystemOwner && (
                     <div className="bg-teal-950/20 border-2 border-teal-500/30 rounded-2xl p-6 space-y-4 animate-fade-in shadow-lg">
                         <div className="flex items-center gap-2 text-teal-400">
                             <span className="w-2.5 h-2.5 rounded-full bg-teal-400 animate-pulse"></span>
                             <h3 className="text-sm font-bold uppercase tracking-wider font-sans">Панель Адміністратора CubeCraft</h3>
                         </div>
                         <p className="text-xs text-teal-200/90 leading-relaxed font-sans">
                             Ви увійшли як власник системи з IP: 195.114.121.171 / 5.58.213.76. Тут ви можете миттєво керувати режимом діагностики ШІ та створювати коди.
                         </p>
                         <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                             <button 
                                 onClick={onToggleDevMode} 
                                 className={`font-semibold py-3 px-4 rounded-xl transition-all shadow-md active:scale-95 text-xs uppercase cursor-pointer font-sans ${
                                     isDevMode 
                                         ? 'bg-red-650 hover:bg-red-700 text-white border border-red-500/20' 
                                         : 'bg-teal-600 hover:bg-teal-700 text-white'
                                 }`}
                             >
                                 {isDevMode ? '⛔ Вимкнути Режим Розробника' : '🛠️ Увімкнути Режим Розробника'}
                             </button>
                             <button 
                                 onClick={() => {
                                     const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                                     let key = '';
                                     for (let i = 0; i < 16; i++) {
                                         key += chars.charAt(Math.floor(Math.random() * chars.length));
                                     }
                                     const newKey = `${key.substring(0,4)}-${key.substring(4,8)}-${key.substring(8,12)}-${key.substring(12,16)}`;
                                     setGeneratedKey(newKey);
                                     onProvision(newKey);
                                 }} 
                                 className="bg-yellow-600 hover:bg-yellow-700 text-white font-semibold py-3 px-4 text-xs uppercase rounded-xl transition-all shadow-md active:scale-95 cursor-pointer font-sans"
                             >
                                 🔑 Згенерувати Ключ Активації
                             </button>
                         </div>
                         
                         {generatedKey && (
                             <div className="mt-2 p-3 bg-gray-900 border border-gray-700 rounded-lg flex justify-between items-center w-full animate-fade-in animate-scale-up">
                                 <span className="font-mono text-sm text-yellow-400 font-bold select-all">{generatedKey}</span>
                                 <CopyButton textToCopy={generatedKey} />
                             </div>
                         )}

                         <div className="text-center pt-1 animate-fade-in">
                             <span className="text-xs font-semibold text-teal-400 font-sans">
                                 Стан Режиму Розробника: {isDevMode ? '🟢 АКТИВНО (доступний огляд логів ШІ та файлів)' : '🔴 ВИМКНЕНО'}
                             </span>
                         </div>
                     </div>
                 )}
                 <div className="space-y-4">
                    <div 
                        onClick={() => setSelectedPlan('attempts')}
                        className={`cursor-pointer transition-all duration-300 p-5 rounded-2xl border-2 flex flex-col space-y-4 ${
                            selectedPlan === 'attempts' 
                                ? 'bg-purple-950/15 border-purple-500 shadow-[0_0_15px_rgba(168,85,247,0.15)]' 
                                : 'bg-gray-900/40 border-gray-800 hover:border-gray-700'
                        }`}
                    >
                        <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-3">
                                <div className={`p-2.5 rounded-xl ${selectedPlan === 'attempts' ? 'bg-purple-500/20 text-purple-400' : 'bg-gray-850 text-gray-550'}`}>
                                    <SparklesIcon className="w-6 h-6" />
                                </div>
                                <div className="text-left font-sans">
                                    <h3 className="font-semibold text-white text-base sm:text-lg">5 спроб за 50 грн</h3>
                                    <p className="text-xs text-gray-400 leading-normal">Підійде для поодинокого перекладу кількох середніх аддонів.</p>
                                </div>
                            </div>
                            <div className="text-right flex-shrink-0 font-sans">
                                <span className="block font-black text-white text-xl">50 грн</span>
                                <span className="text-[10px] text-gray-555 uppercase tracking-widest font-semibold">Разово</span>
                            </div>
                        </div>

                        {selectedPlan === 'attempts' && (
                            <div className="border-t border-gray-850 pt-4 animate-fade-in text-left" onClick={(e) => e.stopPropagation()}>
                                <InstructionSection 
                                    planName="5 спроб" 
                                    price="50 грн" 
                                    userId={userId}
                                    tgNickname={tgNickname}
                                    setTgNickname={setTgNickname}
                                    receiptFiles={receiptFiles}
                                    handleFileChange={handleFileChange}
                                    handleRemoveFile={handleRemoveFile}
                                    handleDragOver={handleDragOver}
                                    handleDrop={handleDrop}
                                    handleSendRequest={handleSendRequest}
                                    isSubmitting={isSubmitting}
                                    error={error}
                                />
                            </div>
                        )}
                    </div>

                    <div 
                        onClick={() => setSelectedPlan('unlimited')}
                        className={`cursor-pointer transition-all duration-300 p-5 rounded-2xl border-2 flex flex-col space-y-4 ${
                            selectedPlan === 'unlimited' 
                                ? 'bg-purple-950/15 border-purple-500 shadow-[0_0_15px_rgba(168,85,247,0.15)]' 
                                : 'bg-gray-900/40 border-gray-800 hover:border-gray-700'
                        }`}
                    >
                        <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-3">
                                <div className={`p-2.5 rounded-xl ${selectedPlan === 'unlimited' ? 'bg-purple-500/20 text-purple-400' : 'bg-gray-850 text-gray-550'}`}>
                                    <GiftIcon className="w-6 h-6" />
                                </div>
                                <div className="text-left font-sans">
                                    <h3 className="font-semibold text-white text-base sm:text-lg">Безкінечний доступ за 200 грн</h3>
                                    <p className="text-xs text-gray-400 leading-normal font-sans">Повний безліміт на всі автоматичні переклади без обмежень.</p>
                                </div>
                            </div>
                            <div className="text-right flex-shrink-0 font-sans">
                                <span className="block font-black text-white text-xl animate-pulse">200 грн</span>
                                <span className="text-[10px] text-purple-400 uppercase tracking-widest font-extrabold">Безкінечно</span>
                            </div>
                        </div>

                        {selectedPlan === 'unlimited' && (
                            <div className="border-t border-gray-850 pt-4 animate-fade-in text-left" onClick={(e) => e.stopPropagation()}>
                                <InstructionSection 
                                    planName="Безкінечний доступ" 
                                    price="200 грн" 
                                    userId={userId}
                                    tgNickname={tgNickname}
                                    setTgNickname={setTgNickname}
                                    receiptFiles={receiptFiles}
                                    handleFileChange={handleFileChange}
                                    handleRemoveFile={handleRemoveFile}
                                    handleDragOver={handleDragOver}
                                    handleDrop={handleDrop}
                                    handleSendRequest={handleSendRequest}
                                    isSubmitting={isSubmitting}
                                    error={error}
                                />
                            </div>
                        )}
                    </div>
                </div>

                <div className="pt-6 border-t border-gray-800 mt-6 animate-fade-in">
                    <div className="bg-gray-950/40 border border-gray-850 p-5 rounded-2xl space-y-3 shadow-inner">
                        <h4 className="text-sm font-semibold text-gray-300 text-center tracking-normal font-sans">Маєте ключ активації або промокод?</h4>
                        <div className="flex flex-col sm:flex-row gap-2.5">
                            <input 
                                type="text" 
                                value={code} 
                                onChange={(e) => setCode(e.target.value.toUpperCase())} 
                                placeholder="XXXX-XXXX-XXXX-XXXX"
                                className="w-full bg-gray-900 border border-gray-700 rounded-xl p-2.5 text-center text-sm font-mono focus:border-brand-primary focus:outline-none uppercase text-white tracking-widest font-bold placeholder:tracking-normal placeholder:font-sans shadow-inner"
                            />
                            <button 
                                onClick={handleSubmitCode} 
                                className="bg-brand-primary hover:bg-brand-secondary text-white font-semibold py-2.5 px-6 rounded-xl transition-all shadow-md active:scale-95 cursor-pointer text-sm whitespace-nowrap font-sans"
                            >
                                Активувати
                            </button>
                        </div>
                        {error && !selectedPlan && <p className="text-red-400 text-xs text-center font-semibold mt-1 font-sans">{error}</p>}
                        {success && <p className="text-green-400 text-xs text-center font-semibold mt-1 font-sans">{success}</p>}

                        {isDevMode && (
                            <div className="pt-3 border-t border-gray-900 text-center space-y-1">
                                <span className="text-[10px] text-purple-400 font-bold uppercase tracking-wider block font-sans">🔑 Секретний ключ активації DEV:</span>
                                <div className="flex items-center justify-center gap-2">
                                    <span className="font-mono text-xs text-yellow-500 font-extrabold select-all tracking-wider bg-black/60 px-2 py-0.5 rounded border border-purple-800/20">
                                        {SECRETS.infinKey}
                                    </span>
                                    <CopyButton textToCopy={SECRETS.infinKey} />
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="bg-gray-900/10 border border-gray-850 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between text-xs text-brand-text-secondary gap-3">
                    <span className="text-left font-medium font-sans">Виникли проблеми з активацією? Звертайтесь в техпідтримку:</span>
                    <div className="flex items-center justify-center gap-1.5 bg-gray-900 border border-gray-800 hover:border-gray-705 rounded-lg py-1.5 px-2.5 transition-colors">
                        <a href="https://t.me/Admiin999cub_keyOn" target="_blank" rel="noopener noreferrer" className="font-semibold text-cyan-400 hover:underline font-sans">@Admiin999cub_keyOn</a>
                        <CopyButton textToCopy="@Admiin999cub_keyOn" className="inline-block" />
                    </div>
                </div>
            </main>

            <footer className="pt-6 border-t border-gray-800">
                <button onClick={handleClose} className="w-full flex items-center justify-center gap-2 bg-gray-750 hover:bg-gray-700 text-white font-semibold py-3.5 px-4 rounded-xl transition-all text-sm cursor-pointer shadow-sm font-sans">
                    <BackIcon className="w-4 h-4"/>Назад до Головного Меню
                </button>
            </footer>
        </div>
    );
};


const AutoTranslatorWithApi: React.FC<{ 
    setView: (view: View) => void; 
    isDevMode: boolean; 
    isOwner: boolean;
    translationState: TranslationState;
    setTranslationState: React.Dispatch<React.SetStateAction<TranslationState>>;
    handleTranslate: (selectedModel: string) => Promise<void>;
    resetState: (full: boolean) => void;
    translateScripts: boolean;
    setTranslateScripts: React.Dispatch<React.SetStateAction<boolean>>;
    zipHasScripts: boolean;
    setZipHasScripts: React.Dispatch<React.SetStateAction<boolean>>;
    zipHasEncryptedScripts: boolean;
    setZipHasEncryptedScripts: React.Dispatch<React.SetStateAction<boolean>>;
    allowTranslateEncrypted: boolean;
    setAllowTranslateEncrypted: React.Dispatch<React.SetStateAction<boolean>>;
    aiLogs: { direction: 'request' | 'response'; model?: string; timestamp: string; content: string; }[];
    setAiLogs?: React.Dispatch<React.SetStateAction<{ direction: 'request' | 'response'; model?: string; timestamp: string; content: string; }[]>>;
    encryptedScriptsCharCount?: number;
    setEncryptedScriptsCharCount?: (val: number) => void;
    handleCancel?: () => void;
    isLimitReached?: boolean;
    setShowBuyAttemptsModal?: (val: boolean) => void;
}> = ({ 
    setView, isDevMode, isOwner, translationState, setTranslationState, 
    handleTranslate: handleTranslateProp, resetState: resetStateProp, 
    translateScripts, setTranslateScripts, zipHasScripts, setZipHasScripts,
    zipHasEncryptedScripts, setZipHasEncryptedScripts,
    allowTranslateEncrypted, setAllowTranslateEncrypted,
    aiLogs, setAiLogs,
    encryptedScriptsCharCount = 0,
    setEncryptedScriptsCharCount,
    handleCancel,
    isLimitReached = false,
    setShowBuyAttemptsModal
}) => {
    const isTelegram = getIsTelegram();
    const [apiKeys, setApiKeys] = useState<ApiKey[]>(() => {
        try {
            return JSON.parse(localStorage.getItem(LS_KEYS.API_KEYS_LIST) || '[]');
        } catch {
            return [];
        }
    });
    const [activeKeyId, setActiveKeyId] = useState<string | null>(() => {
        try {
            const storedKeys = JSON.parse(localStorage.getItem(LS_KEYS.API_KEYS_LIST) || '[]');
            const storedActiveId = localStorage.getItem(LS_KEYS.ACTIVE_API_KEY_ID);
            const activeExists = storedKeys.some((k: ApiKey) => k.id === storedActiveId);
            if (storedActiveId && activeExists) {
                return storedActiveId;
            } else if (storedKeys.length > 0) {
                return storedKeys[0].id;
            }
        } catch {}
        return null;
    });
    const [isManagingKeys, setIsManagingKeys] = useState(() => {
        try {
            const list = JSON.parse(localStorage.getItem(LS_KEYS.API_KEYS_LIST) || '[]');
            return list.length === 0;
        } catch {
            return true;
        }
    });
    const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem(LS_KEYS.SELECTED_AI_MODEL) || 'gemini-3.1-flash-lite');
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let isCancelled = false;
        const reloadFile = async () => {
            if (translationState.originalFile) {
                try {
                    const zip = await JSZip.loadAsync(translationState.originalFile);
                    const allLangFiles = await scanAddonForLangFiles(zip, translateScripts);
                    if (allLangFiles.length === 0 || isCancelled) return;
                    
                    const parsedData = allLangFiles.map(f => parseAnyFile(f.fullPath, f.content)).filter(p => p !== null) as ParsedLangInfo[];
                    const chars = parsedData.reduce((acc, f) => acc + f.originalValues.join('').length, 0);

                    setTranslationState(prev => ({
                        ...prev,
                        estimatedTime: (chars / 1000) + 5,
                        originalLangFiles: allLangFiles,
                        parsedFiles: parsedData,
                        totalChars: chars,
                    }));
                    
                    if (translateScripts && parsedData.some(f => f.fullPath.endsWith('.js'))) {
                        setTranslationState(prev => ({ ...prev, isValidatingScripts: true }));
                        try {
                            const storedKeys = JSON.parse(localStorage.getItem(LS_KEYS.API_KEYS_LIST) || '[]');
                            const storedActiveId = localStorage.getItem(LS_KEYS.ACTIVE_API_KEY_ID);
                            const activeKey = storedKeys.find((k: any) => k.id === storedActiveId);
                            
                            let chatFn;
                            if (activeKey && activeKey.key) {
                                const aiObj = new GoogleGenAI({ apiKey: activeKey.key });
                                chatFn = async (prompt: string) => {
                                    const scriptModel = 'gemma-4-31b-it';
                                    try {
                                        if (isDevMode || isOwner) {
                                            setAiLogs(prev => [...prev, { direction: 'request', model: scriptModel, timestamp: new Date().toISOString(), content: prompt }]);
                                        }
                                        const response = await aiObj.models.generateContent({ model: scriptModel, contents: prompt });
                                        const text = response.text ?? '';
                                        if (isDevMode || isOwner) {
                                            setAiLogs(prev => [...prev, { direction: 'response', model: scriptModel, timestamp: new Date().toISOString(), content: text }]);
                                        }
                                        return text;
                                    } catch (e: any) {
                                        console.warn("Script pre-processing via Gemma model failed on API key, trying selectedModel fallback:", e);
                                        try {
                                            const response2 = await aiObj.models.generateContent({ model: selectedModel, contents: prompt });
                                            const text2 = response2.text ?? '';
                                            return text2;
                                        } catch (e2: any) {
                                            console.warn("Script pre-processing via fallback on API key failed, trying gemma-4-31b-it on puter:", e2);
                                            return safePuterChatWithTimeout(prompt, 'gemma-4-31b-it')
                                                .catch(() => safePuterChatWithTimeout(prompt, 'gemma-2-27b-it'))
                                                .catch(() => safePuterChatWithTimeout(prompt, 'google/gemini-3.1-flash-lite'));
                                        }
                                    }
                                };
                            } else {
                                chatFn = (prompt: string) => safePuterChatWithTimeout(prompt, 'gemma-4-31b-it')
                                    .catch(() => safePuterChatWithTimeout(prompt, 'gemma-2-27b-it'))
                                    .catch(() => safePuterChatWithTimeout(prompt, 'google/gemini-3.1-flash-lite'));
                            }

                            const res = await preProcessScripts(parsedData, chatFn, () => {});
                            if (!isCancelled) {
                                setTranslationState(prev => ({
                                    ...prev,
                                    isValidatingScripts: false,
                                    scriptsThatNeedTranslation: res.scriptsThatNeedTranslation,
                                    scriptsThatAreEncryptedAndNeedTranslation: res.scriptsThatAreEncryptedAndNeedTranslation,
                                    isolatedJsTranslations: res.isolatedJsTranslations
                                }));
                            }
                        } catch (err) {
                            console.error("BG Script Validation error:", err);
                            if (!isCancelled) setTranslationState(prev => ({ ...prev, isValidatingScripts: false }));
                        }
                    } else {
                        setTranslationState(prev => ({ ...prev, isValidatingScripts: false }));
                    }
                } catch (e) {
                    console.error("Error updating scanning after script toggle:", e);
                }
            }
        };
        reloadFile();
        return () => { isCancelled = true; };
    }, [translateScripts, selectedModel, isDevMode, isOwner, activeKeyId]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, []);
    
    const modelsList = [
        { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', desc: 'Найшвидша та найстабільніша модель для перекладу' },
        { id: 'gemini-3.0-flash', name: 'Gemini 3.0 Flash', desc: 'Збалансована та швидка модель попереднього покоління' },
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', desc: 'Стабільна модель з чудовою точністю' },
        { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', desc: 'Найрозумніша модель нового покоління для складних завдань' }
    ];
    
    // Form state
    const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
    const [keyNameInput, setKeyNameInput] = useState('');
    const [keyValueInput, setKeyValueInput] = useState('');
    const [formError, setFormError] = useState<string | null>(null);
    
    const { 
        processingState, statusSteps, currentStep, errorMessage, downloadLink, 
        originalFile, originalFileName, parsedFiles, totalChars, elapsedTime, estimatedTime,
        debugPrompt, debugResponse
    } = translationState;


    useEffect(() => {
        const storedKeys = JSON.parse(localStorage.getItem(LS_KEYS.API_KEYS_LIST) || '[]');
        const storedActiveId = localStorage.getItem(LS_KEYS.ACTIVE_API_KEY_ID);
        setApiKeys(storedKeys);

        if (storedKeys.length === 0 && processingState === ProcessingState.IDLE) {
            setIsManagingKeys(true);
        } else {
            const activeExists = storedKeys.some((k: ApiKey) => k.id === storedActiveId);
            if (storedActiveId && activeExists) {
                setActiveKeyId(storedActiveId);
            } else if (storedKeys.length > 0) {
                const newActiveId = storedKeys[0].id;
                setActiveKeyId(newActiveId);
                localStorage.setItem(LS_KEYS.ACTIVE_API_KEY_ID, newActiveId);
            }
        }
    }, [processingState]);
    
    
    const saveKeys = (keys: ApiKey[], activeId: string | null) => {
        localStorage.setItem(LS_KEYS.API_KEYS_LIST, JSON.stringify(keys));
        if (activeId) localStorage.setItem(LS_KEYS.ACTIVE_API_KEY_ID, activeId);
        else localStorage.removeItem(LS_KEYS.ACTIVE_API_KEY_ID);
        setApiKeys(keys);
        setActiveKeyId(activeId);
    };
    
    const handleAddOrUpdateKey = () => {
        if (!keyNameInput.trim() || !keyValueInput.trim()) {
            setFormError("Назва та ключ не можуть бути порожніми.");
            return;
        }
        let updatedKeys: ApiKey[];
        let newActiveId = activeKeyId;
        const isFirstKey = apiKeys.length === 0;
        
        if (editingKey) { // Update
            updatedKeys = apiKeys.map(k => k.id === editingKey.id ? { ...k, name: keyNameInput, key: keyValueInput } : k);
        } else { // Add new
            const newKey = { id: crypto.randomUUID(), name: keyNameInput, key: keyValueInput };
            updatedKeys = [...apiKeys, newKey];
            if (!newActiveId) newActiveId = newKey.id;
        }
        
        saveKeys(updatedKeys, newActiveId);
        setEditingKey(null);
        setKeyNameInput('');
        setKeyValueInput('');
        setFormError(null);

        if (isFirstKey && !editingKey) {
            setIsManagingKeys(false);
        }
    };
    
    const handleEditKey = (key: ApiKey) => {
        setEditingKey(key);
        setKeyNameInput(key.name);
        setKeyValueInput(key.key);
    };
    
    const handleDeleteKey = (idToDelete: string) => {
        const updatedKeys = apiKeys.filter(k => k.id !== idToDelete);
        let newActiveId = activeKeyId;
        if (activeKeyId === idToDelete) {
            newActiveId = updatedKeys.length > 0 ? updatedKeys[0].id : null;
        }
        saveKeys(updatedKeys, newActiveId);
        if (updatedKeys.length === 0) {
            setIsManagingKeys(true);
        }
    };
    
    const handleSelectKey = (idToSelect: string) => {
        localStorage.setItem(LS_KEYS.ACTIVE_API_KEY_ID, idToSelect);
        setActiveKeyId(idToSelect);
    };
   
    const handleFileDrop = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]; if (!file) return;
        resetStateProp(true);
        try {
            const zip = await JSZip.loadAsync(file);
            const hasJs = await zipHasJsScripts(zip);
            setZipHasScripts(hasJs);
            if (hasJs) {
                const hasEncrypted = await scanForEncryptedScriptsLocally(zip);
                setZipHasEncryptedScripts(hasEncrypted);
                if (hasEncrypted && setEncryptedScriptsCharCount) {
                    const encSize = await getEncryptedScriptsTotalSize(zip);
                    setEncryptedScriptsCharCount(encSize);
                } else if (setEncryptedScriptsCharCount) {
                    setEncryptedScriptsCharCount(0);
                }
            } else {
                setZipHasEncryptedScripts(false);
                if (setEncryptedScriptsCharCount) setEncryptedScriptsCharCount(0);
            }
            
            const allLangFiles = await scanAddonForLangFiles(zip, translateScripts);
            if (allLangFiles.length === 0) throw new Error("Не знайдено файлів 'en_US.lang' або інших підтримуваних файлів для перекладу.");
            
            const parsedData = allLangFiles.map(f => {
                return parseAnyFile(f.fullPath, f.content);
            }).filter(p => p !== null) as ParsedLangInfo[];
            
            const chars = parsedData.reduce((acc, f) => acc + f.originalValues.join('').length, 0);
            
            setTranslationState(prev => ({
                ...prev,
                estimatedTime: (chars / 1000) + 5,
                originalFile: isTelegram ? null : file,
                originalFileName: file.name,
                originalLangFiles: allLangFiles,
                parsedFiles: parsedData,
                totalChars: chars,
            }));

        } catch (error: any) {
            console.error(error);
            setTranslationState(prev => ({
                ...prev,
                errorMessage: error.message || 'Сталася невідома помилка під час сканування файлу.',
                processingState: ProcessingState.ERROR,
            }))
        }
        event.target.value = '';
    }, [resetStateProp, setTranslationState, translateScripts, setZipHasScripts, setZipHasEncryptedScripts]);
    

    const getTranslatedFileName = () => {
        const name = originalFile?.name || originalFileName || '';
        if (!name) return '';
        const parts = name.split('.');
        const extension = parts.pop();
        return `${parts.join('.')}_UKR.${extension}`;
    };

    const currentSelectedModelInfo = modelsList.find(m => m.id === selectedModel) || modelsList[0];

    const KeyManagementUI = (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-bold text-center text-white">Керування API Ключами</h2>
                <p className="text-sm text-center text-brand-text-secondary mt-1">Додайте, виберіть або видаліть ваші Gemini API ключі.</p>
            </div>

            {/* Вибір моделі ШІ */}
            <div className="space-y-3 bg-gradient-to-b from-gray-900/60 to-gray-900/10 border border-gray-800 rounded-2xl p-5 shadow-xl">
                <div className="flex items-center gap-2 text-brand-primary">
                    <SparklesIcon className="w-5 h-5 text-purple-400 stroke-[2]" />
                    <h3 className="text-sm font-semibold uppercase tracking-wider text-teal-400">Активна Модель ШІ</h3>
                </div>
                <p className="text-xs text-brand-text-secondary leading-relaxed">
                    Оберіть модель Gemini для виконання автоматичного перекладу з вашим API ключем.
                </p>
                <div className="relative" ref={dropdownRef}>
                    <button 
                        type="button"
                        onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                        className="w-full bg-gray-950 border border-gray-800 hover:border-brand-primary/50 text-white text-sm rounded-xl focus:ring-2 focus:ring-brand-primary/50 focus:border-brand-primary flex items-center justify-between p-3.5 transition-all cursor-pointer font-medium text-left shadow-lg outline-none"
                    >
                        <div className="flex flex-col">
                            <span className="text-white text-sm font-semibold">{currentSelectedModelInfo.name}</span>
                            <span className="text-gray-400 text-xs mt-0.5 font-normal">{currentSelectedModelInfo.desc}</span>
                        </div>
                        <div className={`transition-transform duration-200 text-gray-500 ${isDropdownOpen ? 'rotate-180 text-brand-primary' : 'rotate-0'}`}>
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" />
                            </svg>
                        </div>
                    </button>

                    {isDropdownOpen && (
                        <div className="absolute w-full mt-2 left-0 right-0 z-50 bg-[#0e111a] border border-gray-800/90 rounded-2xl shadow-2xl py-1.5 flex flex-col gap-1 overflow-hidden backdrop-blur-md animate-fade-in animate-duration-150">
                            {modelsList.map((model) => {
                                const isSelected = model.id === selectedModel;
                                return (
                                    <button
                                        key={model.id}
                                        type="button"
                                        onClick={() => {
                                            setSelectedModel(model.id);
                                            localStorage.setItem(LS_KEYS.SELECTED_AI_MODEL, model.id);
                                            setIsDropdownOpen(false);
                                        }}
                                        className={`w-full text-left px-4 py-3 flex items-center justify-between transition-all duration-150 group cursor-pointer ${
                                            isSelected 
                                                ? 'bg-brand-primary/10 hover:bg-brand-primary/15' 
                                                : 'hover:bg-gray-800/40'
                                        }`}
                                    >
                                        <div className="flex flex-col pr-4">
                                            <span className={`text-sm font-semibold transition-colors duration-150 ${
                                                isSelected ? 'text-teal-400' : 'text-gray-200 group-hover:text-white'
                                            }`}>
                                                {model.name}
                                            </span>
                                            <span className="text-gray-400 text-xs mt-0.5 font-normal leading-normal">
                                                {model.desc}
                                            </span>
                                        </div>
                                        {isSelected && (
                                            <CheckIcon className="w-5 h-5 text-teal-400 flex-shrink-0" />
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            <div className="space-y-4">
                <h3 className="text-lg font-semibold">{editingKey ? 'Редагувати ключ' : 'Додати новий ключ'}</h3>
                <div className="flex flex-col gap-3 p-4 bg-gray-900/50 rounded-lg border border-gray-700">
                    <input type="text" value={keyNameInput} onChange={e => setKeyNameInput(e.target.value)} placeholder="Назва ключа (напр. 'Мій основний')" className="bg-gray-800 border-2 border-gray-600 rounded-md p-2 text-sm focus:border-brand-primary focus:outline-none" />
                    <input type="password" value={keyValueInput} onChange={e => setKeyValueInput(e.target.value)} placeholder="AIza... (Ваш API ключ)" className="font-mono bg-gray-800 border-2 border-gray-600 rounded-md p-2 text-sm focus:border-brand-primary focus:outline-none" />
                    {formError && <p className="text-red-400 text-xs text-center">{formError}</p>}
                    <div className="flex gap-2">
                        <button onClick={handleAddOrUpdateKey} className="flex-grow bg-brand-primary hover:bg-brand-secondary text-white font-bold py-2 px-4 rounded transition-colors">{editingKey ? 'Оновити ключ' : 'Додати ключ'}</button>
                        {editingKey && <button onClick={() => { setEditingKey(null); setKeyNameInput(''); setKeyValueInput(''); }} className="bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded transition-colors">Скасувати</button>}
                    </div>
                </div>
            </div>

            <div className="space-y-2">
                <h3 className="text-lg font-semibold">Збережені ключі</h3>
                {apiKeys.length === 0 ? (
                    <p className="text-brand-text-secondary text-center p-4">У вас ще немає збережених ключів.</p>
                ) : (
                    <ul className="flex flex-col gap-2">
			{apiKeys.map(key => (
                            <li key={key.id} className={`flex items-center gap-2 p-2 rounded-md transition-colors ${activeKeyId === key.id ? 'bg-brand-secondary/30 border-brand-secondary' : 'bg-brand-surface border-gray-700'} border`}>
                                <div className="flex-grow">
                                    <p className="font-bold text-brand-text-primary">{key.name}</p>
                                    <p className="font-mono text-xs text-brand-text-secondary">{key.key.substring(0, 4)}...{key.key.substring(key.key.length - 4)}</p>
                                </div>
                                {activeKeyId === key.id ? (
                                    <span className="text-xs font-bold text-brand-primary bg-brand-primary/20 px-2 py-1 rounded-full">Активний</span>
                                ) : (
                                    <button onClick={() => handleSelectKey(key.id)} className="text-xs font-bold text-gray-300 hover:text-white bg-gray-600 hover:bg-gray-500 px-2 py-1 rounded-full transition-colors">Вибрати</button>
                                )}
                                <button onClick={() => handleEditKey(key)} title="Редагувати" className="p-2 text-gray-400 hover:text-white rounded-md hover:bg-gray-700 transition-colors"><PencilIcon className="w-4 h-4" /></button>
                                <button onClick={() => handleDeleteKey(key.id)} title="Видалити" className="p-2 text-gray-400 hover:text-red-400 rounded-md hover:bg-red-900/50 transition-colors"><TrashIcon className="w-4 h-4" /></button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

             <div className="text-center">
                <p className="text-xs text-brand-text-secondary pt-2">Отримати ключ можна на <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="underline hover:text-brand-primary">Google AI Studio</a>.</p>
             </div>
        </div>
    );

    const TranslatorUI = (
        <>
            {processingState === ProcessingState.IDLE && !(originalFile || originalFileName) ? (
                <div className="space-y-4 w-full">
                    <div className="flex flex-col items-center justify-center border-2 border-dashed border-gray-600 hover:border-brand-primary transition-colors duration-300 rounded-lg p-10 text-center">
                        <UploadIcon className="w-12 h-12 text-gray-500 mb-4" />
                        <label htmlFor="file-upload" className="cursor-pointer bg-brand-primary hover:bg-brand-secondary text-white font-bold py-2 px-4 rounded transition-colors duration-300">Виберіть Аддон для Початку</label>
                        <input id="file-upload" type="file" className="hidden" accept=".mcaddon,.mcpack,.mctemplate" onChange={handleFileDrop} />
                        <p className="mt-4 text-sm text-brand-text-secondary">або перетягніть його сюди</p>
                    </div>
                </div>
            ) : processingState === ProcessingState.IDLE && (originalFile || originalFileName) ? (
                <div className="space-y-6 pt-2 pb-4">
                    <div className="text-center space-y-2">
                        <div className="inline-block bg-brand-primary/10 border border-brand-primary/20 text-brand-primary rounded-full px-4 py-1 text-xs font-semibold uppercase tracking-wider mb-2 select-none">
                            Файл завантажено
                        </div>
                        <h2 className="text-2xl font-bold text-white tracking-tight">Готово до Перекладу</h2>
                    </div>
                    
                    <div className="bg-gray-900/40 border border-gray-800/80 rounded-2xl p-5 space-y-4 shadow-sm">
                        <div className="flex flex-col space-y-1 text-center">
                            <span className="text-xs text-gray-500 font-medium">Назва Вашого Аддону</span>
                            <span className="text-sm font-semibold text-white break-all bg-gray-800/60 border border-gray-700/40 px-3 py-2 rounded-xl inline-block max-w-full mx-auto select-all animate-fade-in">
                                {originalFile?.name || originalFileName || "addon.mcaddon"}
                            </span>
                        </div>
                        
                        <div className="border-t border-gray-800/60 my-2"></div>
                        
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-center">
                            {isDevMode && (
                                <div className="bg-gray-800/30 p-3 rounded-xl border border-gray-700/25">
                                    <span className="block text-xs text-gray-500">Файлів .lang</span>
                                    <span className="text-lg font-bold text-teal-400">{parsedFiles.length}</span>
                                </div>
                            )}
                            <div className={`bg-gray-800/30 p-3 rounded-xl border border-gray-700/25 ${isDevMode ? '' : 'sm:col-span-2'}`}>
                                <span className="block text-xs text-gray-500">Символів для перекладу</span>
                                <span className="text-lg font-bold text-teal-400">{totalChars.toLocaleString('uk-UA')}</span>
                            </div>
                        </div>

                        <ScriptTranslationOptions 
                            translateScripts={translateScripts} 
                            setTranslateScripts={setTranslateScripts} 
                            zipHasScripts={zipHasScripts} 
                            zipHasEncryptedScripts={zipHasEncryptedScripts} 
                            allowTranslateEncrypted={allowTranslateEncrypted} 
                            setAllowTranslateEncrypted={setAllowTranslateEncrypted} 
                            idPrefix="api-ext" 
                        />

                        {estimatedTime > 0 && (
                            <div className="text-center text-xs text-gray-400">
                                Орієнтовний час завершення: <strong className="text-brand-primary">~{formatEstimatedTime(estimatedTime)}</strong>
                            </div>
                        )}

                        {isDevMode && parsedFiles.length > 0 && (
                            <div className="mt-4 p-4 bg-gray-950/60 border border-gray-800/80 rounded-xl space-y-2 text-left animate-fade-in">
                                <h4 className="text-xs font-bold uppercase text-teal-400 tracking-wider">Знайдені файли (тільки для розробника):</h4>
                                <ul className="text-xs font-mono text-gray-300 max-h-[500px] overflow-y-auto space-y-1.5 custom-scrollbar bg-gray-900/50 p-2.5 border border-gray-800 rounded-lg whitespace-normal break-all">
                                    {parsedFiles.map((f, i) => (
                                        <li key={i} className="select-all p-1 hover:bg-gray-800/40 rounded transition-colors" title={f.fullPath}>
                                            <span className="text-teal-400 font-bold pr-1">[{i+1}]</span>{f.fullPath} <span className="text-gray-400 font-semibold">({f.originalValues.length} рядк., ~{f.originalValues.join('').length} симв.)</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>

                    <div className="flex flex-col sm:flex-row gap-3">
                        <button 
                            onClick={() => {
                                if (isLimitReached && setShowBuyAttemptsModal) {
                                    setShowBuyAttemptsModal(true);
                                } else {
                                    handleTranslateProp(selectedModel);
                                }
                            }} 
                            disabled={!activeKeyId || translationState.isValidatingScripts}
                            className="flex-1 bg-brand-primary hover:bg-brand-secondary text-white font-bold py-4 px-4 rounded-xl shadow-lg hover:shadow-xl transition-all duration-300 text-lg transform hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {translationState.isValidatingScripts ? 'Перевіряємо скрипти...' : 'Почати Переклад'}
                        </button>
                        <button onClick={() => resetStateProp(true)} className="bg-gray-800 hover:bg-gray-700 text-white border border-gray-700/60 font-semibold py-4 px-4 rounded-xl transition-all duration-300 text-base">Вибрати інший файл</button>
                    </div>
                </div>
            ) : (
                <div className="space-y-4">
                    {processingState === ProcessingState.PROCESSING && <div className="text-center font-semibold p-3 bg-brand-surface rounded-md"><p>Час виконання: <span className="text-brand-primary text-xl font-mono">{formatTime(elapsedTime)}</span></p>{estimatedTime > 0 && <p className="text-sm text-brand-text-secondary mt-1">Орієнтовний час: ~{formatEstimatedTime(estimatedTime)}</p>}</div>}
                    <div className="flex flex-col space-y-3">{statusSteps.map((step, index) => <StatusItem key={index} text={step} active={index === currentStep && processingState === ProcessingState.PROCESSING} completed={index < currentStep || processingState === ProcessingState.DONE}/>)}</div>
                    {isDevMode && <AiLogsViewer logs={aiLogs} />}
                    {processingState === ProcessingState.ERROR && <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded-lg flex items-start space-x-3"><ErrorIcon className="w-6 h-6 flex-shrink-0 mt-0.5"/><div><p className="font-bold">Сталася помилка</p><p className="text-sm">{errorMessage}</p></div></div>}
                    <div className="pt-4 flex flex-col items-center gap-4">
                        <div className="flex flex-wrap justify-center gap-4">
                            {processingState === ProcessingState.PROCESSING && handleCancel && <button onClick={handleCancel} className="w-full sm:w-auto flex items-center justify-center gap-2 bg-red-800 hover:bg-red-900 text-white font-bold py-3 px-8 rounded-lg text-lg transition-colors"><StopIcon className="w-6 h-6" />Скасувати Переклад</button>}
                            {processingState === ProcessingState.DONE && downloadLink === 'telegram_redirect' && <p className="text-green-400 font-bold">Відкрито у зовнішньому браузері для скачування</p>}
                            {processingState === ProcessingState.DONE && downloadLink && downloadLink !== 'telegram_redirect' && <a href={downloadLink} download={getTranslatedFileName()} className="w-full sm:w-auto text-center bg-brand-primary hover:bg-brand-secondary text-white font-bold py-3 px-8 rounded-lg text-lg transition-transform transform hover:scale-105">Завантажити Перекладене Доповнення</a>}
                            {(processingState === ProcessingState.ERROR || processingState === ProcessingState.DONE) && <button onClick={() => resetStateProp(true)} className="w-full sm:w-auto text-center bg-gray-600 hover:bg-gray-700 text-white font-bold py-3 px-8 rounded-lg text-lg transition-colors">Перекласти Інший Файл</button>}
                        </div>
                        {isDevMode && (processingState === ProcessingState.ERROR || processingState === ProcessingState.DONE) && (
                            <div className="w-full mt-4 pt-4 border-t border-dashed border-gray-600 flex justify-center gap-4 animate-fade-in">
                                <button onClick={() => downloadTextFile(debugPrompt, 'ai_prompt.txt')} className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded text-sm cursor-pointer">Prompt</button>
                                <button onClick={() => downloadTextFile(debugResponse, 'ai_response.txt')} className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded text-sm cursor-pointer">Response</button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
    );
    
    const shouldShowTranslator = processingState !== ProcessingState.IDLE || (apiKeys.length > 0 && !isManagingKeys);

    return (
        <div className="w-full flex flex-col h-full space-y-6">
            <header className="text-center space-y-3 flex flex-col items-center">
                <div className="p-4 bg-gray-900/60 rounded-full shadow-inner border border-gray-800/50 mb-2">
                    <KeyIcon className="w-12 h-12 text-teal-400 drop-shadow-[0_0_15px_rgba(45,212,191,0.4)]" />
                </div>
                <h1 className="text-3xl md:text-4xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white via-gray-200 to-gray-500 tracking-tight drop-shadow-md">
                    Переклад з API ключем
                </h1>
                <p className="text-gray-400 font-medium text-sm md:text-base max-w-lg">Повна потужність Google Gemini для масового перекладу.</p>
            </header>
            <main className="flex-grow">
                {shouldShowTranslator ? TranslatorUI : KeyManagementUI}
            </main>
            <footer className="pt-6 mt-auto border-t border-gray-700">
                <div className="flex flex-col sm:flex-row gap-4">
                     <button onClick={() => setView('menu')} className="w-full flex items-center justify-center gap-2 bg-gray-600 hover:bg-gray-700 text-white font-bold py-2.5 px-4 rounded-xl transition-all duration-350 cursor-pointer"><BackIcon className="w-5 h-5"/>Назад до Головного Меню</button>
                    {apiKeys.length > 0 && <button onClick={() => setIsManagingKeys(!isManagingKeys)} className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 text-white font-bold py-2.5 px-4 rounded-xl transition-all duration-350 cursor-pointer"><KeyIcon className="w-5 h-5"/>{isManagingKeys ? 'Назад до Перекладача' : 'Змінити API Ключ'}</button>}
                </div>
            </footer>
        </div>
    );
};

const AutoTranslator: React.FC<{ 
    setView: (view: View) => void; 
    isDevMode: boolean;
    isOwner: boolean;
    translationState: TranslationState;
    setTranslationState: React.Dispatch<React.SetStateAction<TranslationState>>;
    handleTranslate: () => Promise<void>;
    resetState: (full: boolean) => void;
    handleCancel: () => void;
    translateScripts: boolean;
    setTranslateScripts: React.Dispatch<React.SetStateAction<boolean>>;
    zipHasScripts: boolean;
    setZipHasScripts: React.Dispatch<React.SetStateAction<boolean>>;
    zipHasEncryptedScripts: boolean;
    setZipHasEncryptedScripts: React.Dispatch<React.SetStateAction<boolean>>;
    allowTranslateEncrypted: boolean;
    setAllowTranslateEncrypted: React.Dispatch<React.SetStateAction<boolean>>;
    aiLogs: { direction: 'request' | 'response'; model?: string; timestamp: string; content: string; }[];
    encryptedScriptsCharCount?: number;
    setEncryptedScriptsCharCount?: (val: number) => void;
    isLimitReached?: boolean;
    setShowBuyAttemptsModal?: (val: boolean) => void;
}> = ({ 
    setView, isDevMode, isOwner, translationState, setTranslationState, 
    handleTranslate: handleTranslateProp, resetState: resetStateProp, handleCancel, 
    translateScripts, setTranslateScripts, zipHasScripts, setZipHasScripts,
    zipHasEncryptedScripts, setZipHasEncryptedScripts,
    allowTranslateEncrypted, setAllowTranslateEncrypted,
    aiLogs,
    encryptedScriptsCharCount = 0,
    setEncryptedScriptsCharCount,
    isLimitReached = false,
    setShowBuyAttemptsModal
}) => {
    const isTelegram = getIsTelegram();
    
    const { 
        processingState, statusSteps, currentStep, errorMessage, downloadLink, 
        originalFile, originalFileName, parsedFiles, totalChars, elapsedTime, estimatedTime,
        debugPrompt, debugResponse
    } = translationState;

    const [isInfoExpanded, setIsInfoExpanded] = useState(false);

    useEffect(() => {
        let isCancelled = false;
        const reloadFile = async () => {
            if (translationState.originalFile) {
                try {
                    const zip = await JSZip.loadAsync(translationState.originalFile);
                    const allLangFiles = await scanAddonForLangFiles(zip, translateScripts);
                    if (allLangFiles.length === 0 || isCancelled) return;
                    
                    const parsedData = allLangFiles.map(f => parseAnyFile(f.fullPath, f.content)).filter(p => p !== null) as ParsedLangInfo[];
                    const chars = parsedData.reduce((acc, f) => acc + f.originalValues.join('').length, 0);

                    setTranslationState(prev => ({
                        ...prev,
                        estimatedTime: (chars / 500) + 5,
                        originalLangFiles: allLangFiles,
                        parsedFiles: parsedData,
                        totalChars: chars,
                    }));

                    if (translateScripts && parsedData.some(f => f.fullPath.endsWith('.js'))) {
                        setTranslationState(prev => ({ ...prev, isValidatingScripts: true }));
                        try {
                            const chatFn = (prompt: string) => safePuterChatWithTimeout(prompt, 'gemma-4-31b-it')
                                .catch(() => safePuterChatWithTimeout(prompt, 'gemma-2-27b-it'))
                                .catch(() => safePuterChatWithTimeout(prompt, 'google/gemini-3.1-flash-lite'));
                            const res = await preProcessScripts(parsedData, chatFn, () => {});
                            if (!isCancelled) {
                                setTranslationState(prev => ({
                                    ...prev,
                                    isValidatingScripts: false,
                                    scriptsThatNeedTranslation: res.scriptsThatNeedTranslation,
                                    scriptsThatAreEncryptedAndNeedTranslation: res.scriptsThatAreEncryptedAndNeedTranslation,
                                    isolatedJsTranslations: res.isolatedJsTranslations
                                }));
                            }
                        } catch (err) {
                            console.error("BG Script Validation error:", err);
                            if (!isCancelled) setTranslationState(prev => ({ ...prev, isValidatingScripts: false }));
                        }
                    } else {
                        setTranslationState(prev => ({ ...prev, isValidatingScripts: false }));
                    }
                } catch (e) {
                    console.error("Error updating scanning after script toggle in AutoTranslator:", e);
                }
            }
        };
        reloadFile();
        return () => { isCancelled = true; };
    }, [translateScripts]);

    const handleFileDrop = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]; if (!file) return;
        resetStateProp(true);
        try {
            const zip = await JSZip.loadAsync(file);
            const hasJs = await zipHasJsScripts(zip);
            setZipHasScripts(hasJs);
            if (hasJs) {
                const hasEncrypted = await scanForEncryptedScriptsLocally(zip);
                setZipHasEncryptedScripts(hasEncrypted);
                if (hasEncrypted && setEncryptedScriptsCharCount) {
                    const encSize = await getEncryptedScriptsTotalSize(zip);
                    setEncryptedScriptsCharCount(encSize);
                } else if (setEncryptedScriptsCharCount) {
                    setEncryptedScriptsCharCount(0);
                }
            } else {
                setZipHasEncryptedScripts(false);
                if (setEncryptedScriptsCharCount) setEncryptedScriptsCharCount(0);
            }

            const allLangFiles = await scanAddonForLangFiles(zip, translateScripts);
            if (allLangFiles.length === 0) throw new Error("Не знайдено файлів 'en_US.lang' або інших підтримуваних файлів для перекладу.");
            
            const parsedData = allLangFiles.map(f => {
                return parseAnyFile(f.fullPath, f.content);
            }).filter(p => p !== null) as ParsedLangInfo[];

            const chars = parsedData.reduce((acc, f) => acc + f.originalValues.join('').length, 0);

            setTranslationState(prev => ({
                ...prev,
                estimatedTime: (chars / 500) + 5,
                originalFile: isTelegram ? null : file,
                originalFileName: file.name,
                originalLangFiles: allLangFiles,
                parsedFiles: parsedData,
                totalChars: chars,
            }));

        } catch (error: any) {
            console.error(error);
            setTranslationState(prev => ({
                ...prev,
                errorMessage: error.message || 'Сталася невідома помилка під час сканування файлу.',
                processingState: ProcessingState.ERROR,
            }))
        }
        event.target.value = '';
    }, [resetStateProp, setTranslationState, translateScripts, setZipHasScripts, setZipHasEncryptedScripts]);

    const getTranslatedFileName = () => {
        const name = originalFile?.name || originalFileName || '';
        if (!name) return '';
        const parts = name.split('.');
        return `${parts.slice(0, -1).join('.')}_UKR.${parts.slice(-1)}`;
    };

    return (
        <div className="w-full flex flex-col h-full space-y-6">
            <header className="text-center space-y-3 flex flex-col items-center">
                <div className="p-4 bg-gray-900/60 rounded-full shadow-inner border border-gray-800/50 mb-2">
                    <SparklesIcon className="w-12 h-12 text-purple-400 drop-shadow-[0_0_15px_rgba(168,85,247,0.4)]" />
                </div>
                <h1 className="text-3xl md:text-4xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white via-gray-200 to-gray-500 tracking-tight drop-shadow-md">
                    Автоматичний Переклад
                </h1>
                <p className="text-gray-400 font-medium text-sm md:text-base max-w-lg">Найпростіший спосіб для авто-перекладу малих аддонів.</p>
            </header>
            <main className="flex-grow">
                {processingState === ProcessingState.IDLE && !(originalFile || originalFileName) ? (
                    <div className="space-y-4 w-full">
                        <div className="flex flex-col items-center justify-center border-2 border-dashed border-gray-600 hover:border-purple-500 transition-colors duration-300 rounded-lg p-10 text-center">
                            <UploadIcon className="w-12 h-12 text-gray-500 mb-4" />
                            <label htmlFor="file-upload-no-api" className="cursor-pointer bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded transition-colors duration-300">Виберіть Аддон для Початку</label>
                            <input id="file-upload-no-api" type="file" className="hidden" accept=".mcaddon,.mcpack,.mctemplate" onChange={handleFileDrop} />
                            <p className="mt-4 text-sm text-brand-text-secondary">або перетягніть його сюди</p>
                        </div>
                        
                        <div className="mt-4 bg-yellow-900/50 border border-yellow-700 rounded-lg">
                            <button
                                onClick={() => setIsInfoExpanded(!isInfoExpanded)}
                                className="w-full flex justify-between items-center p-3 text-left outline-none cursor-pointer"
                                aria-expanded={isInfoExpanded}
                            >
                                <div className="flex items-start space-x-3">
                                    <InfoIcon className="w-6 h-6 flex-shrink-0 mt-0.5 text-yellow-300"/>
                                    <strong className="text-yellow-300">Увага: Важлива інформація про ліміти та використання.</strong>
                                </div>
                                <ChevronDownIcon className={`w-5 h-5 text-yellow-300 transition-transform duration-300 ${isInfoExpanded ? 'rotate-180' : ''}`} />
                            </button>
                            <div className={`transition-all duration-500 ease-in-out overflow-hidden ${isInfoExpanded ? 'max-h-96' : 'max-h-0'}`}>
                                <div className="px-3 pb-3 text-sm text-yellow-300 space-y-2">
                                    <p>Цей режим використовує сервіс, який має суворові ліміти по використанню.</p>
                                    <p>Якщо ліміт вичерпано незалежно від спроб, цей режим стане недоступним на протязі 24-48 годин.</p>
                                    <p>Для надійної роботи рекомендується використовувати режим <strong>"Переклад з API ключем"</strong>.</p>
                                </div>
                            </div>
                        </div>
                    </div>
                ) : processingState === ProcessingState.IDLE && (originalFile || originalFileName) ? (
                    <div className="space-y-6 pt-2 pb-4">
                        <div className="text-center space-y-2">
                            <div className="inline-block bg-purple-50/10 border border-purple-500/20 text-purple-400 rounded-full px-4 py-1 text-xs font-semibold uppercase tracking-wider mb-2 select-none">
                                Файл завантажено
                            </div>
                            <h2 className="text-2xl font-bold text-white tracking-tight">Готово до Перекладу</h2>
                        </div>
                        
                        <div className="bg-gray-900/40 border border-gray-800/80 rounded-2xl p-5 space-y-4 shadow-sm animate-fade-in">
                            <div className="flex flex-col space-y-1 text-center">
                                <span className="text-xs text-gray-500 font-medium">Назва Вашого Аддону</span>
                                <span className="text-sm font-semibold text-white break-all bg-gray-800/60 border border-gray-700/40 px-3 py-2 rounded-xl inline-block max-w-full mx-auto select-all">
                                    {originalFile?.name || originalFileName || "addon.mcaddon"}
                                </span>
                            </div>
                            
                            <div className="border-t border-gray-800/60 my-2"></div>
                            
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-center">
                                {isDevMode && (
                                    <div className="bg-gray-800/30 p-3 rounded-xl border border-gray-700/25">
                                        <span className="block text-xs text-gray-500">Файлів .lang</span>
                                        <span className="text-lg font-bold text-purple-400">{parsedFiles.length}</span>
                                    </div>
                                )}
                                <div className={`bg-gray-800/30 p-3 rounded-xl border border-gray-700/25 ${isDevMode ? '' : 'sm:col-span-2'}`}>
                                    <span className="block text-xs text-gray-500">Символів для перекладу</span>
                                    <span className="text-lg font-bold text-purple-400">{totalChars.toLocaleString('uk-UA')}</span>
                                </div>
                            </div>

                            <ScriptTranslationOptions 
                                translateScripts={translateScripts} 
                                setTranslateScripts={setTranslateScripts} 
                                zipHasScripts={zipHasScripts} 
                                zipHasEncryptedScripts={zipHasEncryptedScripts} 
                                allowTranslateEncrypted={allowTranslateEncrypted} 
                                setAllowTranslateEncrypted={setAllowTranslateEncrypted} 
                                idPrefix="no-api" 
                            />

                            {estimatedTime > 0 && (
                                <div className="text-center text-xs text-gray-400">
                                    Орієнтовний час завершення: <strong className="text-purple-400">~{formatEstimatedTime(estimatedTime)}</strong>
                                </div>
                            )}

                            {isDevMode && parsedFiles.length > 0 && (
                                <div className="mt-4 p-4 bg-gray-950/60 border border-gray-800/80 rounded-xl space-y-2 text-left">
                                    <h4 className="text-xs font-bold uppercase text-teal-400 tracking-wider">Знайдені файли (тільки для розробника):</h4>
                                    <ul className="text-xs font-mono text-gray-300 max-h-[500px] overflow-y-auto space-y-1.5 custom-scrollbar bg-gray-900/50 p-2.5 border border-gray-800 rounded-lg whitespace-normal break-all select-all">
                                        {parsedFiles.map((f, i) => (
                                            <li key={i} className="p-1 hover:bg-gray-800/40 rounded transition-colors" title={f.fullPath}>
                                                <span className="text-purple-400 font-bold pr-1">[{i+1}]</span>{f.fullPath} <span className="text-gray-400 font-semibold">({f.originalValues.length} рядк., ~{f.originalValues.join('').length} симв.)</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>

                        <div className="flex flex-col sm:flex-row gap-3">
                            <button 
                                onClick={() => {
                                    if (isLimitReached && setShowBuyAttemptsModal) {
                                        setShowBuyAttemptsModal(true);
                                    } else {
                                        handleTranslateProp();
                                    }
                                }} 
                                disabled={translationState.isValidatingScripts}
                                className="flex-1 bg-purple-600 hover:bg-purple-500 text-white font-bold py-4 px-4 rounded-xl shadow-lg hover:shadow-xl transition-all duration-300 text-lg transform hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {translationState.isValidatingScripts ? 'Перевіряємо скрипти...' : 'Почати Переклад'}
                            </button>
                            <button onClick={() => resetStateProp(true)} className="bg-gray-800 hover:bg-gray-700 text-white border border-gray-700/60 font-semibold py-4 px-4 rounded-xl transition-all duration-300 text-base">Вибрати інший файл</button>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {processingState === ProcessingState.PROCESSING && <div className="text-center font-semibold p-3 bg-brand-surface rounded-md"><p>Час виконання: <span className="text-purple-400 text-xl font-mono">{formatTime(elapsedTime)}</span></p>{estimatedTime > 0 && <p className="text-sm text-brand-text-secondary mt-1">Орієнтовний час: ~{formatEstimatedTime(estimatedTime)}</p>}</div>}
                        <div className="flex flex-col space-y-3">{statusSteps.map((step, index) => <StatusItem key={index} text={step} active={index === currentStep && processingState === ProcessingState.PROCESSING} completed={index < currentStep || processingState === ProcessingState.DONE}/>)}</div>
                        {isDevMode && <AiLogsViewer logs={aiLogs} />}
                        {processingState === ProcessingState.ERROR && <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded-lg flex items-start space-x-3"><ErrorIcon className="w-6 h-6 flex-shrink-0 mt-0.5"/><div><p className="font-bold">Сталася помилка</p><p className="text-sm">{errorMessage}</p></div></div>}
                        <div className="pt-4 flex flex-col items-center gap-4">
                             <div className="flex flex-wrap justify-center gap-4 animate-fade-in">
                                {processingState === ProcessingState.PROCESSING && <button onClick={handleCancel} className="w-full sm:w-auto flex items-center justify-center gap-2 bg-red-800 hover:bg-red-900 text-white font-bold py-3 px-8 rounded-lg text-lg transition-colors"><StopIcon className="w-6 h-6" />Скасувати Переклад</button>}
                                {processingState === ProcessingState.DONE && downloadLink === 'telegram_redirect' && <p className="text-green-400 font-bold">Відкрито у зовнішньому браузері для скачування</p>}
                                {processingState === ProcessingState.DONE && downloadLink && downloadLink !== 'telegram_redirect' && <a href={downloadLink} download={getTranslatedFileName()} className="w-full sm:w-auto text-center bg-brand-primary hover:bg-brand-secondary text-white font-bold py-3 px-8 rounded-lg text-lg transition-transform transform hover:scale-105">Завантажити Перекладене Доповнення</a>}
                                {(processingState === ProcessingState.ERROR || processingState === ProcessingState.DONE) && <button onClick={() => resetStateProp(true)} className="w-full sm:w-auto text-center bg-gray-600 hover:bg-gray-700 text-white font-bold py-3 px-8 rounded-lg text-lg transition-colors">Перекласти Інший Файл</button>}
                             </div>
                            {isDevMode && (processingState === ProcessingState.ERROR || processingState === ProcessingState.DONE) && (
                                <div className="w-full mt-4 pt-4 border-t border-dashed border-gray-600 flex justify-center gap-4 animate-fade-in">
                                    <button onClick={() => downloadTextFile(debugPrompt, 'ai_prompt.txt')} className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded text-sm cursor-pointer">Prompt</button>
                                    <button onClick={() => downloadTextFile(debugResponse, 'ai_response.txt')} className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded text-sm cursor-pointer">Response</button>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </main>
            <footer className="pt-6 mt-auto border-t border-gray-700">
                <button onClick={() => setView('menu')} className="w-full flex items-center justify-center gap-2 bg-gray-600 hover:bg-gray-700 text-white font-bold py-2.5 px-4 rounded-xl transition-all duration-350 cursor-pointer"><BackIcon className="w-5 h-5"/>Назад до Головного Меню</button>
            </footer>
        </div>
    );
};

const ManualTranslator: React.FC<{ 
    setView: (view: View) => void; 
    onTranslationSuccess: () => void; 
    translateScripts: boolean;
    setTranslateScripts: React.Dispatch<React.SetStateAction<boolean>>;
    zipHasScripts: boolean;
    setZipHasScripts: React.Dispatch<React.SetStateAction<boolean>>;
    zipHasEncryptedScripts: boolean;
    setZipHasEncryptedScripts: React.Dispatch<React.SetStateAction<boolean>>;
    allowTranslateEncrypted: boolean;
    setAllowTranslateEncrypted: React.Dispatch<React.SetStateAction<boolean>>;
    encryptedScriptsCharCount: number;
    setEncryptedScriptsCharCount: React.Dispatch<React.SetStateAction<number>>;
    isDevMode: boolean;
    isOwner: boolean;
    isLimitReached?: boolean;
    setShowBuyAttemptsModal?: (val: boolean) => void;
}> = ({ setView, onTranslationSuccess, translateScripts, setTranslateScripts, zipHasScripts, setZipHasScripts, zipHasEncryptedScripts, setZipHasEncryptedScripts, allowTranslateEncrypted, setAllowTranslateEncrypted, encryptedScriptsCharCount, setEncryptedScriptsCharCount, isDevMode, isOwner, isLimitReached = false, setShowBuyAttemptsModal }) => {
    const isTelegram = getIsTelegram();
    const [step, setStep] = useState(1);
    const [aiInstructions, setAiInstructions] = useState('');
    const [downloadLink, setDownloadLink] = useState<string | null>(null);
    const [originalFileName, setOriginalFileName] = useState('');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const originalFileRef = useRef<File | null>(null);
    const originalLangFilesRef = useRef<LangFileInfo[]>([]);
    const parsedFilesRef = useRef<ParsedLangInfo[]>([]);
    const [translationInput, setTranslationInput] = useState('');
    const [isValidTranslation, setIsValidTranslation] = useState(false);
    const [forceAllowRepack, setForceAllowRepack] = useState(false);
    const [processingState, setProcessingState] = useState<ProcessingState>(ProcessingState.IDLE);
    const [statusSteps, setStatusSteps] = useState<string[]>([]);
    const [currentStep, setCurrentStep] = useState(-1);
    const downloadLinkRef = useRef<string | null>(null);
    const [showInstructions, setShowInstructions] = useState(false);
    const [copied, setCopied] = useState(false);
    const [translatedBlocksCount, setTranslatedBlocksCount] = useState(0);
    const [totalExpectedBlocks, setTotalExpectedBlocks] = useState(0);
    const [validateFlip, setValidateFlip] = useState(false);
    const [totalChars, setTotalChars] = useState(0);
    
    const reset = useCallback(() => {
        setStep(1); setAiInstructions('');
        if (downloadLinkRef.current) { URL.revokeObjectURL(downloadLinkRef.current); downloadLinkRef.current = null; }
        setDownloadLink(null); setOriginalFileName(''); setErrorMessage(null);
        originalFileRef.current = null; parsedFilesRef.current = []; originalLangFilesRef.current = [];
        setTranslationInput(''); setIsValidTranslation(false); setForceAllowRepack(false);
        setProcessingState(ProcessingState.IDLE); setStatusSteps([]); setCurrentStep(-1);
        setShowInstructions(false);
    }, []);

    useEffect(() => { return () => { reset(); }; }, [reset]);

    const analyzeScripts = async (zip: any) => {
        const results: { fileFullPath: string; content: string; type: 'ENCRYPTED' | 'CLEAR' }[] = [];
        const jsFiles = zip.file(/scripts\/.*\.js$/);
        for (const fileObj of jsFiles) {
            const content = await fileObj.async('string');
            if (content) {
                const isEncrypted = /_0x[a-f0-9]{4,}/i.test(content) ||
                                    /eval\s*\(\s*function/i.test(content) ||
                                    /eval\s*\(/i.test(content) ||
                                    /\\x[0-9a-fA-F]{2}/i.test(content) ||
                                    (content.includes('eval') && content.length > 5000 && !content.includes(' '));
                results.push({
                    fileFullPath: fileObj.name,
                    content,
                    type: isEncrypted ? 'ENCRYPTED' : 'CLEAR'
                });
            }
        }
        return results;
    };

    const handleTranslateScriptsToggle = async (val: boolean) => {
        if (val) {
            let fileObjToUse = originalFileRef.current;
            if (fileObjToUse) {
                try {
                    const zip = await JSZip.loadAsync(fileObjToUse);
                    const analyses = await analyzeScripts(zip);
                    const encryptedJS = analyses.filter(a => a.type === 'ENCRYPTED');
                    if (encryptedJS.length > 0) {
                        setZipHasEncryptedScripts(true);
                        setEncryptedScriptsCharCount(encryptedJS.reduce((sum, f) => sum + f.content.length, 0));
                        
                        const confirmMsg = `⚠️ Увага! У вашому аддоні виявлено зашифровані/обфусковані скрипти (${encryptedJS.length} шт.).\n\nБажаєте дозволити їх переклад повністю в один об'єднаний запит?\n\n(Натисніть OK, щоб надати згоду на їх переклад, або Скасувати, щоб пропустити їх)`;
                        const ok = window.confirm(confirmMsg);
                        setAllowTranslateEncrypted(ok);
                    } else {
                        setZipHasEncryptedScripts(false);
                        setAllowTranslateEncrypted(false);
                        setEncryptedScriptsCharCount(0);
                    }
                } catch (e) {
                    console.error("Error analyzing scripts on checkbox activation:", e);
                }
            }
            setTranslateScripts(true);
        } else {
            setTranslateScripts(false);
            setZipHasEncryptedScripts(false);
            setAllowTranslateEncrypted(false);
        }
    };

    const generateInstructionsAndProceed = async () => {
        let fileObjToUse = originalFileRef.current;
        if (!fileObjToUse && !originalFileName) {
            setErrorMessage("Будь ласка, спочатку завантажте файл доповнення.");
            return;
        }
        
        try {
            setErrorMessage(null);
            if (fileObjToUse) {
                const zip = await JSZip.loadAsync(fileObjToUse);
                const allLangFiles = await scanAddonForLangFiles(zip, translateScripts);
                if (allLangFiles.length === 0) {
                    throw new Error("Не знайдено файлів 'en_US.lang' або інших підтримуваних файлів для перекладу.");
                }
                
                originalLangFilesRef.current = allLangFiles;
                const parsedData: ParsedLangInfo[] = allLangFiles.map(f => parseAnyFile(f.fullPath, f.content)).filter(p => p !== null) as ParsedLangInfo[];
                parsedFilesRef.current = parsedData;

                const translationBlocks: string[] = [];
                parsedData.forEach(f => {
                    f.originalValues.forEach(val => {
                        translationBlocks.push(`${START_DELIMITER}${val}${END_DELIMITER}`);
                    });
                });
                const translationPool = translationBlocks.join('');
                
                let extraScriptsText = "";
                if (translateScripts && allowTranslateEncrypted) {
                    const analyses = await analyzeScripts(zip);
                    const encryptedJS = analyses.filter(a => a.type === 'ENCRYPTED');
                    if (encryptedJS.length > 0) {
                        extraScriptsText += `\n\n--- Зашифровані скрипти для перекладу (ПОВНІСТЮ) ---\n`;
                        encryptedJS.forEach(f => {
                            extraScriptsText += `// START_ENCRYPTED_FILE: ${f.fileFullPath}\n${f.content}\n// END_ENCRYPTED_FILE: ${f.fileFullPath}\n\n`;
                        });
                    }
                }

                const instructions = `**SYSTEM COMMAND: IMMEDIATE EXECUTION.**
**ROLE:** You are a stateless, high-performance translation automaton. Your sole purpose is to translate the provided text block in a single operation.
**PRIMARY DIRECTIVE:** Translate the English text found ONLY inside the special markers ${START_DELIMITER}...${END_DELIMITER} to Ukrainian.

**ABSOLUTE, UNBREAKABLE OUTPUT PROTOCOL:**
-   **FORMAT:** RAW PLAIN TEXT. No JSON, no markdown, no code fences.
-   **STRUCTURE:** Your response must be a single, unbroken line of concatenated translated blocks, like so: \`${START_DELIMITER}переклад 1${END_DELIMITER}${START_DELIMITER}переклад 2${END_DELIMITER}\`.
-   **TRANSLATION LOGIC:** Translate ONLY the text values that appear inside the ${START_DELIMITER}...${END_DELIMITER} markers. The markers themselves MUST be preserved.
-   **TRANSLATION & BRANDING LOGIC (WATERMARK):**
    -   If you identify a pack name or "name" field, translate it to Ukrainian, and REMOVE any mention of the author or original developer (such as "By Ranzie", "Ranzie's Visual Effects"). DO NOT keep the author name.
    -   If you identify a pack description or "description" field, translate it to Ukrainian, and REMOVE any mention of the author/original developer.
    -   Do not manually add branding suffixes here, as the app code will append them programmatically to be completely safe.
-   **ЯКІСТЬ ПЕРЕКЛАДУ:** Обов'язково покращуй переклад для полів імені та опису і загалом всього тексту. Дописуй або перефразовуй текст так, щоб він звучав ідеально, зрозуміло та природньо українською мовою, зберігаючи оригінальний зміст.
${translateScripts && allowTranslateEncrypted ? `-   **АВТОМАТИЧНА ОБРОБКА ЗАШИФРОВАНИХ СКРИПТІВ:** Якщо нижче надано зашифровані скрипти у блоках \`// START_ENCRYPTED_FILE\`, проаналізуй їх. Якщо знайдеш текст для перекладу - переклади його, зберігаючи СТРУКТУРУ І ФОРМАТ ШИФРУВАННЯ КОДУ на 100%. Якщо тексту немає або ти не можеш гарантувати працездатність коду після перекладу, просто напиши для цього блоку "Не вдалося перекласти зашифровані скрипт" і поверни оригінальний код без змін. Код скриптів повертай тільки в блоках // START_ENCRYPTED_FILE: шлях // END_ENCRYPTED_FILE: шлях після основних маркерів тексту.\n` : ''}-   **TERMINATION SEQUENCE:** The entire output MUST terminate with the exact sequence on a new line: \`${COMPLETION_MARKER}\`. This sequence must appear only once, at the very end of the complete response.

**EXECUTE.**

--- **INPUT DATA** ---
${translationPool}${extraScriptsText}`;

                setAiInstructions(instructions);
            }
            setStep(2);
        } catch (e: any) {
            setErrorMessage(e.message || "Не вдалося згенерувати інструкції.");
        }
    };

    useEffect(() => {
        const input = translationInput.trim();
        const expected = parsedFilesRef.current.reduce((sum, f) => sum + f.originalValues.length, 0);
        setTotalExpectedBlocks(expected);

        if (input === '' || parsedFilesRef.current.length === 0) {
            setIsValidTranslation(false); 
            setTranslatedBlocksCount(0);
            setErrorMessage(null); 
            return;
        }

        let foundBlocks = 0;
        let isPoolFormat = input.includes('||=||');

        if (isPoolFormat) {
            const poolLines = input.split(/\r?\n/);
            poolLines.forEach(line => {
                const eqIdx = line.indexOf('||=||');
                if (eqIdx > -1) {
                    const left = line.substring(0, eqIdx).trim();
                    for (const f of parsedFilesRef.current) {
                        if (left.startsWith(f.fullPath + ':')) {
                            foundBlocks++;
                            break;
                        }
                    }
                }
            });
        } else {
            const translatedValues = parseTranslationBlock(input);
            foundBlocks = translatedValues.length;
        }
        
        setTranslatedBlocksCount(foundBlocks);

        if (foundBlocks !== expected) {
            setIsValidTranslation(false);
            if (isPoolFormat) {
                setErrorMessage(`Розбіжність: знайдено ${foundBlocks} з необхідних ${expected} блоків. Перевірте, чи не пропустив ШІ якісь рядки з маркуванням ||=||.`);
            } else {
                setErrorMessage(`Розбіжність: знайдено ${foundBlocks} з необхідних ${expected} блоків. Перевірте, чи не пропустив ШІ маркування §{...}§.`);
            }
        } else {
            setIsValidTranslation(true);
            setErrorMessage(null);
        }
    }, [translationInput, validateFlip]);

    const addStepStatus = (message: string) => { setStatusSteps(prev => [...prev, message]); setCurrentStep(prev => prev + 1); };

    const getTranslatedFileName = () => {
        if (!originalFileName) return '';
        const parts = originalFileName.split('.');
        return `${parts.slice(0, -1).join('.')}_UKR.${parts.slice(-1)}`;
    };
    
    const processUploadedFile = async (file: File) => {
        setErrorMessage(null);
        setDownloadLink(null);
        setTranslationInput('');
        setIsValidTranslation(false);
        setProcessingState(ProcessingState.IDLE);
        setStatusSteps([]);
        setCurrentStep(-1);
        setShowInstructions(false);

        originalFileRef.current = isTelegram ? null : file;
        setOriginalFileName(file.name);
        try {
            const zip = await JSZip.loadAsync(file);
            const hasJs = await zipHasJsScripts(zip);
            setZipHasScripts(hasJs);
            
            if (hasJs) {
                const analyses = await analyzeScripts(zip);
                const encryptedJS = analyses.filter(a => a.type === 'ENCRYPTED');
                if (encryptedJS.length > 0) {
                    setZipHasEncryptedScripts(true);
                    setEncryptedScriptsCharCount(encryptedJS.reduce((sum, f) => sum + f.content.length, 0));
                } else {
                    setZipHasEncryptedScripts(false);
                    setEncryptedScriptsCharCount(0);
                }
            } else {
                setZipHasEncryptedScripts(false);
                setEncryptedScriptsCharCount(0);
            }

            const allLangFiles = await scanAddonForLangFiles(zip, translateScripts);
            if (allLangFiles.length === 0) throw new Error("Не вдалося знайти файлів 'en_US.lang' або інших підтримуваних файлів для перекладу.");
            
            originalLangFilesRef.current = allLangFiles;
            const parsedData: ParsedLangInfo[] = allLangFiles.map(f => {
                return parseAnyFile(f.fullPath, f.content);
            }).filter(p => p !== null) as ParsedLangInfo[];
            parsedFilesRef.current = parsedData;

            let charCount = 0;
            parsedData.forEach(p => {
                p.originalValues.forEach(val => charCount += val.length);
            });
            setTotalChars(charCount);

            setStep(1.5);
        } catch (error: any) {
            setErrorMessage(error.message || "Не вдалося обробити файл доповнення.");
            reset();
        }
    };

    const handleInitialUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]; if (!file) return;
        await processUploadedFile(file);
        event.target.value = '';
    }, [reset, translateScripts]);

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    const handleDrop = useCallback(async (e: React.DragEvent) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        await processUploadedFile(file);
    }, [reset, translateScripts]);

    const buildEncryptedPrompt = (encryptedFiles: { fileFullPath: string; content: string }[]) => {
        let prompt = `УВАГА! ІНСТРУКЦІЯ ДЛЯ ШІ:\n«Знайди всередині цього зашифрованого коду приховані англійські тексти, переклади їх українською мовою та поверни точний початковий код, замінивши лише рядки перекладу. Не змінюй логіку та назви функцій обфускатора».\n\n`;
        encryptedFiles.forEach(f => {
            prompt += `// START_ENCRYPTED_FILE: ${f.fileFullPath}\n${f.content}\n// END_ENCRYPTED_FILE: ${f.fileFullPath}\n\n`;
        });
        return prompt;
    };

    const handleDownloadEncryptedInstructions = async () => {
        if (!originalFileRef.current) return;
        try {
            const zip = await JSZip.loadAsync(originalFileRef.current);
            const analyses = await analyzeScripts(zip);
            const encryptedJS = analyses.filter(a => a.type === 'ENCRYPTED');
            if (encryptedJS.length === 0) return;
            const prompt = buildEncryptedPrompt(encryptedJS);
            
            const blob = new Blob([prompt], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'encrypted_scripts_instructions_for_ai.txt';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error(e);
            setErrorMessage("Не вдалося завантажити інструкції для зашифрованих файлів.");
        }
    };

    const handleRepack = async () => {
        if (isLimitReached && setShowBuyAttemptsModal) {
            setShowBuyAttemptsModal(true);
            return;
        }

        const fileLoaded = isTelegram ? !!originalFileName : !!originalFileRef.current;
        const canRepack = isValidTranslation || (forceAllowRepack && translatedBlocksCount > 0);
        if (!fileLoaded || !canRepack) {
            setErrorMessage("Помилка: Немає вихідного файлу або переклад невалідний.");
            return;
        }

        setStep(3); setProcessingState(ProcessingState.PROCESSING);
        setErrorMessage(null); setStatusSteps([]); setCurrentStep(-1);

        try {
            addStepStatus("Читання та розбір наданого перекладу...");
            
            const isPoolFormat = translationInput.includes('||=||');
            const translations: Record<string, string> = {};
            const encryptedReplacements: Record<string, string> = {};

            // 1. Parse encrypted replacements from tags if present
            let tempContent = translationInput;
            const startMarkerPrefix = '// START_ENCRYPTED_FILE:';
            const endMarkerPrefix = '// END_ENCRYPTED_FILE:';
            
            let searchIdx = 0;
            while (true) {
                const startIdx = tempContent.indexOf(startMarkerPrefix, searchIdx);
                if (startIdx === -1) break;
                
                const startLineEnd = tempContent.indexOf('\n', startIdx);
                if (startLineEnd === -1) break;
                
                const startLine = tempContent.substring(startIdx, startLineEnd).trim();
                const filePath = startLine.substring(startMarkerPrefix.length).trim();
                
                const endMarker = `${endMarkerPrefix} ${filePath}`;
                let endIdx = tempContent.indexOf(endMarker, startLineEnd);
                if (endIdx === -1) {
                    endIdx = tempContent.indexOf(`${endMarkerPrefix}${filePath}`, startLineEnd);
                }
                
                if (endIdx > -1) {
                    const fileCode = tempContent.substring(startLineEnd + 1, endIdx).trim();
                    const isUnsupported = fileCode.includes("Не вдалося перекласти зашифровані скрипт") || 
                                          fileCode.includes("нічого немає") || 
                                          fileCode.includes("не вдалося перекласти") || 
                                          fileCode.includes("не знайдено") ||
                                          fileCode.trim() === "";
                    if (!isUnsupported) {
                        encryptedReplacements[filePath] = fileCode;
                    }
                    searchIdx = endIdx + endMarker.length;
                } else {
                    searchIdx = startLineEnd + 1;
                }
            }

            // 2. Parse ||=|| standard translation lines
            if (isPoolFormat) {
                const lines = translationInput.split(/\r?\n/);
                const keyValueMap: Record<string, Record<string, string>> = {};
                
                lines.forEach(line => {
                    const eqIdx = line.indexOf('||=||');
                    if (eqIdx > -1) {
                        const left = line.substring(0, eqIdx).trim();
                        const val = line.substring(eqIdx + 5).trim();
                        
                        for (const f of parsedFilesRef.current) {
                            if (left.startsWith(f.fullPath + ':')) {
                                const key = left.substring(f.fullPath.length + 1).trim();
                                if (!keyValueMap[f.fullPath]) {
                                    keyValueMap[f.fullPath] = {};
                                }
                                keyValueMap[f.fullPath][key] = val;
                                break;
                            }
                        }
                    }
                });
                
                parsedFilesRef.current.forEach(parsedFile => {
                    const translatedValues: string[] = [];
                    parsedFile.originalValues.forEach((origVal, i) => {
                        let keyName = `str_${i}`;
                        let checkIdx = 0;
                        for (const item of parsedFile.skeleton) {
                            if (item.isTranslatable) {
                                if (checkIdx === i) {
                                    if (item.key) {
                                        keyName = item.key.replace('=', '').trim();
                                    }
                                    break;
                                }
                                checkIdx++;
                            }
                        }
                        
                        let matchedVal = origVal;
                        if (keyValueMap[parsedFile.fullPath]) {
                            if (keyValueMap[parsedFile.fullPath][i.toString()] !== undefined) {
                                matchedVal = keyValueMap[parsedFile.fullPath][i.toString()];
                            } else if (keyValueMap[parsedFile.fullPath][keyName] !== undefined) {
                                matchedVal = keyValueMap[parsedFile.fullPath][keyName];
                            }
                        }
                        translatedValues.push(matchedVal);
                    });
                    
                    const newContent = rebuildAnyFile(parsedFile.fullPath, parsedFile.skeleton, parsedFile.originalValues, translatedValues);
                    translations[parsedFile.fullPath] = newContent;
                });
                
            } else {
                const allTranslatedValues = parseTranslationBlock(translationInput);
                let valueCursor = 0;

                parsedFilesRef.current.forEach(parsedFile => {
                    const valuesForThisFile = allTranslatedValues.slice(valueCursor, valueCursor + parsedFile.originalValues.length);
                    const newContent = rebuildAnyFile(parsedFile.fullPath, parsedFile.skeleton, parsedFile.originalValues, valuesForThisFile);
                    translations[parsedFile.fullPath] = newContent;
                    valueCursor += parsedFile.originalValues.length;
                });
            }
            
            addStepStatus("Застосування перекладів...");
            
            // Handle Telegram Mini App logic
            if (isTelegram) {
                addStepStatus("Підготовка файлів для скачування через браузер...");
                const finalStorageTranslations = { ...translations, ...encryptedReplacements };
                localStorage.setItem('telegram_translations', JSON.stringify(finalStorageTranslations));
                localStorage.setItem('telegram_filename', originalFileName || "addon.mcaddon");
                
                const originURL = window.location.href.split('?')[0].replace(/\/[^\/]*$/, '/');
                const url = originURL + "download.html";
                
                const tg = (window as any).Telegram?.WebApp;
                if (tg && typeof tg.openLink === 'function') {
                    tg.openLink(url);
                } else {
                    window.open(url, '_blank');
                }
                setDownloadLink('telegram_redirect');
                setProcessingState(ProcessingState.DONE);
                onTranslationSuccess();
                return;
            }

            const zip = await JSZip.loadAsync(originalFileRef.current);
            const processedZip = await applyTranslations(zip, translations, originalLangFilesRef.current);

            // Write encrypted replacements recursively
            const replacedPaths = Object.keys(encryptedReplacements);
            if (replacedPaths.length > 0) {
                addStepStatus(`Заміна ${replacedPaths.length} зашифрованих скриптів оригінальним кодом з перекладом...`);
                for (const path of replacedPaths) {
                    await writeArbitraryPathInZip(processedZip, path, encryptedReplacements[path]);
                }
            }

            addStepStatus("Перепакування перекладеного доповнення...");
            const blob = await processedZip.generateAsync({ type: 'blob', mimeType: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            setDownloadLink(url); downloadLinkRef.current = url;
            setProcessingState(ProcessingState.DONE);
            onTranslationSuccess();
        } catch (error: any) {
            setErrorMessage(error.message || "Не вдалося перепакувати доповнення.");
            setProcessingState(ProcessingState.ERROR);
        }
    };
    
    const handleDownload = () => { setTimeout(() => { reset(); }, 1000); };
    const handlePaste = async () => { try { const text = await navigator.clipboard.readText(); setTranslationInput(text); } catch { setErrorMessage('Не вдалося прочитати дані з буферу обміну. Вставте вручну.'); } };
    
    const handleDownloadInstructions = () => {
        const blob = new Blob([aiInstructions], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'instructions_for_ai.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleTranslatedFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            setTranslationInput(text);
        } catch (error) {
            setErrorMessage("Не вдалося прочитати завантажений файл.");
        }
        event.target.value = '';
    };

    const handleCopyContinue = () => {
        navigator.clipboard.writeText(CONTINUE_PROMPT_PHRASE);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="w-full space-y-6">
            <header className="text-center space-y-3 flex flex-col items-center">
                <div className="p-4 bg-gray-900/60 rounded-full shadow-inner border border-gray-800/50 mb-2">
                    <ManualIcon className="w-12 h-12 text-amber-400 drop-shadow-[0_0_15px_rgba(251,191,36,0.4)]" />
                </div>
                <h1 className="text-3xl md:text-4xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white via-gray-200 to-gray-500 tracking-tight drop-shadow-md">
                    Ручний Переклад
                </h1>
                <p className="text-gray-400 font-medium text-sm md:text-base max-w-lg">Отримайте тексти та перекладіть їх вашим улюбленим ШІ.</p>
            </header>
            <main className="space-y-6">
                {step === 1 && (
                     <div className="space-y-4 w-full">
                        <label 
                            htmlFor="manual-file-upload" 
                            onDragOver={handleDragOver}
                            onDrop={handleDrop}
                            className="flex flex-col items-center justify-center bg-gray-900/40 border-2 border-dashed border-gray-600/50 hover:border-brand-secondary hover:bg-gray-900/60 transition-all duration-300 rounded-2xl p-12 text-center shadow-inner cursor-pointer"
                        >
                            <UploadIcon className="w-14 h-14 text-gray-500 mb-6 group-hover:text-brand-secondary transition-colors" />
                            <span className="bg-brand-secondary hover:bg-green-500 text-white font-bold py-3 px-6 rounded-xl shadow-lg transition-colors duration-300 transform hover:-translate-y-1 inline-block">Виберіть Аддон для Початку</span>
                            <input id="manual-file-upload" type="file" className="hidden" accept=".mcaddon,.mcpack,.mctemplate" onChange={handleInitialUpload} />
                            <p className="mt-4 text-sm text-gray-400">або перетягніть його сюди</p>
                        </label>
                        {errorMessage && <p className="text-red-400 text-center font-semibold bg-red-900/30 py-2 rounded-lg border border-red-800/50">{errorMessage}</p>}
                    </div>
                )}
                {step === 1.5 && (
                    <div className="space-y-6 pt-2 pb-4">
                        <div className="bg-gray-900/40 border border-gray-800/80 rounded-2xl p-5 space-y-4 shadow-sm animate-fade-in text-left">
                            <div className="flex flex-col space-y-1 text-center">
                                <span className="text-xs text-gray-400 font-medium">Назва Вашого Аддону</span>
                                <span className="text-sm font-semibold text-white break-all bg-gray-850/60 border border-gray-700/40 px-3 py-2 rounded-xl inline-block max-w-full mx-auto select-all">
                                    {originalFileRef.current?.name || originalFileName || "addon.mcaddon"}
                                </span>
                            </div>
                            
                            <div className="flex flex-col space-y-1 text-center mt-3">
                                <span className="text-xs text-gray-400 font-medium">Символів для перекладу</span>
                                <span className="text-sm font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-lg inline-block w-fit mx-auto">
                                    {totalChars}
                                </span>
                            </div>
                            
                            <div className="border-t border-gray-850/60 my-2"></div>
                            
                            <ScriptTranslationOptions 
                                translateScripts={translateScripts} 
                                setTranslateScripts={handleTranslateScriptsToggle} 
                                zipHasScripts={zipHasScripts} 
                                zipHasEncryptedScripts={zipHasEncryptedScripts} 
                                allowTranslateEncrypted={allowTranslateEncrypted} 
                                setAllowTranslateEncrypted={setAllowTranslateEncrypted} 
                                idPrefix="manual-settings" 
                                encryptedScriptsCharCount={encryptedScriptsCharCount}
                            />
                        </div>

                        <button 
                            onClick={generateInstructionsAndProceed}
                            className="w-full bg-amber-600 hover:bg-amber-500 text-white font-bold py-3.5 px-4 rounded-xl shadow-lg hover:shadow-xl transition-all duration-300 text-sm cursor-pointer"
                        >
                            Далі (Отримати Інструкцію)
                        </button>
                    </div>
                )}
                {step === 2 && (
                    <div className="space-y-6">
                        <div>
                            <h2 className="text-xl font-semibold mb-2">Крок 1: Отримайте Переклад від ШІ</h2>
                             <div className="border border-gray-700 rounded-lg overflow-hidden">
                                <button
                                    onClick={() => setShowInstructions(!showInstructions)}
                                    className="w-full flex justify-between items-center p-3 bg-brand-surface hover:bg-gray-800 transition-colors"
                                    aria-expanded={showInstructions}
                                    aria-controls="manual-instructions"
                                >
                                    <span className="font-bold text-brand-text-secondary">Важливо: Як працювати з великими файлами?</span>
                                    <ChevronDownIcon className={`w-5 h-5 text-brand-text-secondary transition-transform duration-300 ${showInstructions ? 'rotate-180' : ''}`} />
                                </button>
                                <div
                                    id="manual-instructions"
                                    className={`transition-all duration-500 ease-in-out ${showInstructions ? 'max-h-[1000px] opacity-100' : 'max-h-0 opacity-0'}`}
                                >
                                    <div className="p-4 text-brand-text-secondary text-sm space-y-2 border-t border-gray-700">
                                        <p>ШІ може не надати весь переклад за один раз, якщо текст дуже великий.</p>
                                        <ol className="list-decimal list-inside space-y-2 pl-2">
                                            <li>Завантажте інструкцію та надішліть її повністю у чат з ШІ.</li>
                                            <li>Уважно перевірте кінець відповіді від ШІ. Чи є там текст: <code className="text-yellow-400 bg-yellow-900/50 rounded px-1 py-0.5 font-mono">{COMPLETION_MARKER}</code>?</li>
                                            <li className="flex items-center gap-2 flex-wrap">
                                                <span>Якщо цього тексту НЕМАЄ, надішліть:</span>
                                                <div className="inline-flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-md pl-2">
                                                    <code className="text-yellow-400 font-mono">{CONTINUE_PROMPT_PHRASE}</code>
                                                    <button onClick={handleCopyContinue} className="p-1.5 border-l border-gray-700 rounded-r-md hover:bg-gray-700 transition-colors" title="Скопіювати">
                                                        {copied ? <CheckIcon className="w-4 h-4 text-green-400" /> : <CopyIcon className="w-4 h-4 text-gray-400" />}
                                                    </button>
                                                </div>
                                            </li>
                                            <li>Повторюйте крок 3, доки не отримаєте відповідь із маркером завершення.</li>
                                            <li>Скопіюйте ПЕРШУ частину відповіді та вставте її в поле нижче. Потім скопіюйте ДРУГУ частину і вставте її в те ж поле ВІДРАЗУ ПІСЛЯ першої. Продовжуйте, доки не зберете всю відповідь.</li>
                                        </ol>
                                    </div>
                                </div>
                            </div>
                            <p className="text-brand-text-secondary my-4">Завантажте інструкції та вставте її у чат зі ШІ.</p>
                            <div className="flex flex-col sm:flex-row gap-4">
                                <button onClick={handleDownloadInstructions} className="w-full bg-brand-secondary hover:bg-green-800 text-white font-bold py-2 px-4 rounded transition-colors text-sm">Завантажити Інструкцію для ШІ</button>
                                <a href="https://aistudio.google.com/app" target="_blank" rel="noopener noreferrer" className="w-full text-center bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded transition-colors text-sm flex items-center justify-center font-sans">Відкрити Google AI Studio →</a>
                            </div>

                            {translateScripts && zipHasEncryptedScripts && (
                                <div className="mt-4 p-4 bg-amber-950/30 border border-amber-800/40 rounded-xl space-y-3">
                                    <p className="text-amber-300 text-xs leading-relaxed text-left font-sans">
                                        🔒 У вашому аддоні виявлено <strong>зашифровані скрипти</strong>. Завантажте додаткову інструкцію для зашифрованого коду та перекладіть його окремо:
                                    </p>
                                    <button 
                                        onClick={handleDownloadEncryptedInstructions} 
                                        className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-2 px-4 rounded transition-colors text-sm font-sans"
                                    >
                                        Завантажити інструкції для зашифрованих скриптів
                                    </button>
                                </div>
                            )}

                            {isDevMode && parsedFilesRef.current.length > 0 && (
                                <div className="mt-4 p-4 bg-gray-950/60 border border-gray-800/80 rounded-xl space-y-2 text-left">
                                    <h4 className="text-xs font-bold uppercase text-teal-400 tracking-wider">Знайдені файли (тільки для розробника):</h4>
                                    <ul className="text-xs font-mono text-gray-400 max-h-32 overflow-y-auto space-y-1 custom-scrollbar">
                                        {parsedFilesRef.current.map((f, i) => (
                                            <li key={i} className="truncate select-all" title={f.fullPath}>
                                                • {f.fullPath} ({f.originalValues.length} рядк.)
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                        <div className="border-t border-gray-700 pt-6">
                            <h2 className="text-xl font-semibold mb-2">Крок 2: Надайте Перекладений Вміст</h2>
                            <p className="text-brand-text-secondary mb-4">Вставте повну відповідь від ШІ або завантажте її з файлу.</p>
                            <div className="space-y-4">
                                <div className="relative">
                                    <textarea value={translationInput} onChange={(e) => setTranslationInput(e.target.value)} placeholder="Вставте повну відповідь від ШІ тут..." rows={8}
                                        className={`resize-none custom-scrollbar w-full bg-gray-900 border-2 rounded-md p-3 pr-10 text-sm font-mono text-brand-text-primary focus:outline-none transition-colors ${isValidTranslation ? 'border-green-500' : forceAllowRepack && translatedBlocksCount > 0 ? 'border-amber-500' : errorMessage ? 'border-red-500' : 'border-gray-700'}`} />
                                    <button onClick={() => setTranslationInput('')} title="Очистити" className="absolute top-2 right-2 p-1 text-gray-400 hover:text-white rounded-full hover:bg-gray-700 transition-colors"><TrashIcon className="w-5 h-5"/></button>
                                </div>
                                
                                {translationInput.trim() !== '' && (
                                    <div className="space-y-3 p-4 bg-gray-950/40 rounded-xl border border-gray-800/80 animate-fade-in text-left">
                                        <div className="flex items-center justify-between text-xs text-gray-400">
                                            <div className="flex items-center gap-1.5 font-medium">
                                                <span className="relative flex h-2 w-2">
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                                                </span>
                                                <span>Автоматичний аналіз тексту: Активний</span>
                                            </div>
                                            <button 
                                                onClick={() => {
                                                    setValidateFlip(prev => !prev);
                                                }}
                                                className="text-cyan-400 hover:text-cyan-300 transition-colors font-bold uppercase select-none cursor-pointer"
                                                title="Перевірити текст вручну"
                                            >
                                                Перевірити ще раз ↻
                                            </button>
                                        </div>
                                        
                                        {totalExpectedBlocks > 0 && (
                                            <div className="space-y-3">
                                                {isValidTranslation ? (
                                                    <div className="bg-green-950/40 border border-green-800/60 p-3 rounded-lg flex items-center gap-2">
                                                        <CheckIcon className="w-5 h-5 text-green-400 flex-shrink-0" />
                                                        <p className="text-green-400 text-sm font-semibold select-all text-left">
                                                            Валідація успішна! Знайдено {translatedBlocksCount} з {totalExpectedBlocks} необхідних блоків. Все ідеально підходить!
                                                        </p>
                                                    </div>
                                                ) : (
                                                    <div className="space-y-3">
                                                        <div className="bg-amber-950/40 border border-amber-800/60 p-3 rounded-lg flex items-start gap-2">
                                                            <ErrorIcon className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                                                            <div className="space-y-1 text-left">
                                                                <p className="text-amber-400 text-sm font-bold">⚠️ Розбіжність у кількості блоків ({translatedBlocksCount} з {totalExpectedBlocks})</p>
                                                                <p className="text-gray-300 text-xs leading-relaxed">
                                                                    Знайдено {translatedBlocksCount} з необхідних {totalExpectedBlocks} блоків. ШІ міг випадково опустити або не повністю скопіювати деякі маркери. 
                                                                    <br />
                                                                    <strong>Не хвилюйтесь!</strong> Ви все одно можете перепакувати доповнення. Будь-які не виявлені або бракуючі блоки ШІ будуть автоматично заповнені з оригінального англійського файлу, тож ваш аддон працюватиме чудово!
                                                                </p>
                                                            </div>
                                                        </div>
                                                        
                                                        <label className="flex items-center gap-2.5 bg-gray-900 border border-gray-800 rounded-lg p-2.5 hover:bg-gray-900/80 transition-all cursor-pointer select-none">
                                                            <input 
                                                                type="checkbox" 
                                                                checked={forceAllowRepack} 
                                                                onChange={(e) => setForceAllowRepack(e.target.checked)}
                                                                className="rounded border-gray-700 bg-gray-800 text-brand-primary focus:ring-brand-primary h-4 w-4"
                                                            />
                                                            <span className="text-xs text-gray-300 font-semibold text-left">Все одно дозволити перепакувати з заповненням браку за оригіналом</span>
                                                        </label>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}

                                <div className="flex flex-col sm:flex-row gap-4">
                                    <button onClick={handlePaste} className="w-full bg-gray-600 hover:bg-gray-700 text-white font-bold py-2.5 px-3 rounded transition-colors cursor-pointer animate-fade-in">Вставити з буфера</button>
                                    <label htmlFor="translated-file-upload" className="w-full text-center cursor-pointer bg-gray-600 hover:bg-gray-700 text-white font-bold py-2.5 px-3 rounded transition-colors flex items-center justify-center animate-fade-in">
                                        Завантажити відповідь ШІ з файлу
                                    </label>
                                    <input id="translated-file-upload" type="file" className="hidden" accept=".txt,text/plain" onChange={handleTranslatedFileUpload} />
                                </div>
                                <button onClick={handleRepack} disabled={!isValidTranslation && !(forceAllowRepack && translatedBlocksCount > 0)} className="w-full bg-brand-primary hover:bg-brand-secondary text-white font-bold py-3.5 px-4 rounded transition-colors disabled:bg-gray-600 disabled:text-gray-400 disabled:cursor-not-allowed">Перепакувати Доповнення</button>
                            </div>
                        </div>
                    </div>
                )}
                {step === 3 && (
                    <div className="space-y-4">
                        <div className="flex flex-col space-y-3">{statusSteps.map((step, index) => <StatusItem key={index} text={step} active={index === currentStep && processingState === ProcessingState.PROCESSING} completed={index < currentStep || processingState === ProcessingState.DONE}/>)}</div>
                        {processingState === ProcessingState.ERROR && <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded-lg flex items-start space-x-3"><ErrorIcon className="w-6 h-6 flex-shrink-0 mt-0.5"/><div><p className="font-bold">Сталася помилка</p><p className="text-sm">{errorMessage}</p></div></div>}
                        <div className="pt-4 flex flex-col sm:flex-row flex-wrap justify-center gap-4">
                            {processingState === ProcessingState.DONE && downloadLink === 'telegram_redirect' && <p className="text-green-400 font-bold">Відкрито у зовнішньому браузері для скачування</p>}
                            {processingState === ProcessingState.DONE && downloadLink && downloadLink !== 'telegram_redirect' && <a href={downloadLink} download={getTranslatedFileName()} onClick={handleDownload} className="w-full sm:w-auto text-center bg-brand-primary hover:bg-brand-secondary text-white font-bold py-3 px-8 rounded-lg text-lg transition-transform transform hover:scale-105">Завантажити Перекладене Доповнення</a>}
                             {processingState === ProcessingState.ERROR && <button onClick={() => { setProcessingState(ProcessingState.IDLE); setStep(2); }} className="w-full sm:w-auto text-center bg-gray-600 hover:bg-gray-700 text-white font-bold py-3 px-8 rounded-lg text-lg transition-colors">Повернутися до Редагування</button>}
                            {(processingState === ProcessingState.ERROR || processingState === ProcessingState.DONE) && <button onClick={reset} className="w-full sm:w-auto text-center bg-gray-600 hover:bg-gray-700 text-white font-bold py-3 px-8 rounded-lg text-lg transition-colors">Перекласти Інший Файл</button>}
                        </div>
                    </div>
                )}
            </main>
            <div className="pt-6 mt-6 border-t border-gray-700 flex flex-col sm:flex-row gap-3">
                {step !== 1 && (
                    <button onClick={reset} className="flex-1 bg-gray-800 hover:bg-gray-700 text-white border border-gray-700/60 font-semibold py-3 px-4 rounded-xl transition-all duration-350 text-sm">
                        Вибрати інший файл
                    </button>
                )}
                <button onClick={() => setView('menu')} className="flex-1 flex items-center justify-center gap-2 bg-gray-600 hover:bg-gray-700 text-white font-bold py-3 px-4 rounded-xl transition-colors text-sm">
                    <BackIcon className="w-5 h-5" /><span>Назад до Головного Меню</span>
                </button>
            </div>
        </div>
    );
};


// --- MAIN APP COMPONENT ---

export default function App() {
    const isTelegram = getIsTelegram();
    const [view, setView] = useState<View>('menu');
    const [usageCount, setUsageCount] = useState(0);
    const [hasUnlimited, setHasUnlimited] = useState(false);
    const remainingAttempts = USAGE_LIMIT - usageCount;
    const isLimitReached = remainingAttempts <= 0 && !hasUnlimited;
    const [userId, setUserId] = useState('');
    const [activationCodes, setActivationCodes] = useState<string[]>([]);
    const [specialView, setSpecialView] = useState(false);
    const [isDevMode, setIsDevMode] = useState(false);
    const [isOwner, setIsOwner] = useState(false);
    const [translateScripts, setTranslateScripts] = useState(false);
    const [zipHasScripts, setZipHasScripts] = useState(false);
    const [zipHasEncryptedScripts, setZipHasEncryptedScripts] = useState(false);
    const [allowTranslateEncrypted, setAllowTranslateEncrypted] = useState(false);
    const [encryptedScriptsCharCount, setEncryptedScriptsCharCount] = useState(0);
    const [showBuyAttemptsModal, setShowBuyAttemptsModal] = useState(false);
    const [aiLogs, setAiLogs] = useState<{ direction: 'request' | 'response'; model?: string; timestamp: string; content: string; }[]>([]);
    const [isPolling, setIsPolling] = useState(() => {
        return localStorage.getItem('mc_payment_polling_active') === 'true';
    });
    const [isBanned, setIsBanned] = useState(() => {
        return localStorage.getItem('mc_banned') === 'true';
    });

    // Ініціалізація Telegram Mini App: розгортаємо на весь екран, узгоджуємо кольори
    // та вимикаємо випадкове згортання свайпом — для зручності на телефоні.
    useEffect(() => {
        const tg = (window as any).Telegram?.WebApp;
        if (!tg) return;
        try {
            tg.ready();
            tg.expand();
            if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
            if (typeof tg.setHeaderColor === 'function') tg.setHeaderColor('#121212');
            if (typeof tg.setBackgroundColor === 'function') tg.setBackgroundColor('#121212');
        } catch (e) {
            console.warn('Telegram WebApp init skipped:', e);
        }
    }, []);

    const executeServerCommand = useCallback((command: string) => {
        if (!command) return;
        
        if (command === 'approved_5') {
            setUsageCount(prev => {
                const newCount = prev - 5;
                localStorage.setItem(LS_KEYS.USAGE, newCount.toString());
                return newCount;
            });
            setIsPolling(false);
            localStorage.removeItem('mc_payment_polling_active');
            localStorage.removeItem('mc_payment_active');
        } else if (command === 'approved_unlim') {
            setHasUnlimited(true);
            localStorage.setItem(LS_KEYS.UNLIMITED, 'true');
            setIsPolling(false);
            localStorage.removeItem('mc_payment_polling_active');
            localStorage.removeItem('mc_payment_active');
        } else if (command.startsWith('give_')) {
            const amountStr = command.replace('give_', '');
            const amount = parseInt(amountStr, 10);
            if (!isNaN(amount)) {
                setUsageCount(prev => {
                    const newCount = Math.max(0, prev - amount); // Add X attempts (meaning decrease usage by X)
                    localStorage.setItem(LS_KEYS.USAGE, newCount.toString());
                    return newCount;
                });
            }
            setIsPolling(false);
            localStorage.removeItem('mc_payment_polling_active');
            localStorage.removeItem('mc_payment_active');
            // send request to reset status to active
            const params = new URLSearchParams({ 
                action: "updateStatus", 
                token: SECRETS.secretToken, 
                userId: userId, 
                newStatus: "active" 
            });
            fetch(`${SECRETS.scriptUrl}?${params.toString()}`).catch(console.error);
        } else if (command.startsWith('take_')) {
            const amountStr = command.replace('take_', '');
            const amount = parseInt(amountStr, 10);
            if (!isNaN(amount)) {
                setUsageCount(prev => {
                    const newCount = prev + amount; // Subtract X attempts (increase usage by X)
                    localStorage.setItem(LS_KEYS.USAGE, newCount.toString());
                    return newCount;
                });
            }
            setIsPolling(false);
            localStorage.removeItem('mc_payment_polling_active');
            localStorage.removeItem('mc_payment_active');
            // send request to reset status to active
            const params = new URLSearchParams({ 
                action: "updateStatus", 
                token: SECRETS.secretToken, 
                userId: userId, 
                newStatus: "active" 
            });
            fetch(`${SECRETS.scriptUrl}?${params.toString()}`).catch(console.error);
        } else if (command === 'banned') {
            setIsBanned(true);
            localStorage.removeItem(LS_KEYS.USAGE);
            localStorage.removeItem(LS_KEYS.UNLIMITED);
            localStorage.setItem('mc_banned', 'true');
            setIsPolling(false);
            localStorage.removeItem('mc_payment_polling_active');
        } else if (command === 'rejected') {
            setIsPolling(false);
            localStorage.removeItem('mc_payment_polling_active');
        }
    }, [userId]);

    // Polling effect
    useEffect(() => {
        if (!isPolling || !userId || isBanned) return;

        const checkStatus = async () => {
            try {
                const params = new URLSearchParams({ action: "check", userId: userId });
                const response = await fetch(`${SECRETS.scriptUrl}?${params.toString()}`);
                if (response.ok) {
                    const text = await response.text();
                    try {
                        const data = JSON.parse(text);
                        if (data && data.command) {
                            executeServerCommand(data.command);
                        } else if (data && data.status && data.status !== 'pending' && data.status !== 'active' && data.status !== 'not_found') {
                            executeServerCommand(data.status);
                        }
                    } catch(e) {
                         // simple text response?
                         if (text && text !== 'pending' && text !== 'active' && text !== 'not_found' && text !== 'ok') {
                             executeServerCommand(text);
                         }
                    }
                }
            } catch (err) {
                console.error("Polling error:", err);
            }
        };

        checkStatus();

        const intervalId = setInterval(checkStatus, 12000); // 12 seconds per requirement
        return () => clearInterval(intervalId);
    }, [isPolling, userId, isBanned, executeServerCommand]);

    const [encryptedConfirmModal, setEncryptedConfirmModal] = useState<{
        isOpen: boolean;
        resolve: (permission: boolean) => void;
    } | null>(null);

    const askForEncryptedPermission = (): Promise<boolean> => {
        return new Promise((resolve) => {
            setEncryptedConfirmModal({
                isOpen: true,
                resolve: (val) => {
                    setEncryptedConfirmModal(null);
                    resolve(val);
                }
            });
        });
    };

    // State for Auto Translator
    const [autoTranslationState, setAutoTranslationState] = useState<TranslationState>(initialTranslationState);
    const autoTimerRef = useRef<number | null>(null);
    const autoDownloadLinkRef = useRef<string | null>(null);
    const autoIsCancelledRef = useRef(false);

    // State for API Translator
    const [apiTranslationState, setApiTranslationState] = useState<TranslationState>(initialTranslationState);
    const apiTimerRef = useRef<number | null>(null);
    const apiDownloadLinkRef = useRef<string | null>(null);
    const apiIsCancelledRef = useRef(false);

    const generateUserId = () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < 12; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    };

    useEffect(() => {
        const storedUsage = parseInt(localStorage.getItem(LS_KEYS.USAGE) || '0', 10);
        const storedUnlimited = localStorage.getItem(LS_KEYS.UNLIMITED) === 'true';
        const storedDevMode = localStorage.getItem(LS_KEYS.DEV_MODE) === 'true';
        setUsageCount(storedUsage);
        setHasUnlimited(storedUnlimited);
        setIsDevMode(storedDevMode);

        let storedId = localStorage.getItem(LS_KEYS.USER_ID);
        if (!storedId) {
            storedId = generateUserId();
            localStorage.setItem(LS_KEYS.USER_ID, storedId);
        }
        setUserId(storedId);

        const paymentActive = localStorage.getItem('mc_payment_active') === 'true';
        if (paymentActive) {
            setView('unlimited');
        }

        // Fetch IP for unlimited access with multiple fallbacks
        const fetchIP = async () => {
            const urls = [
                "https://api.ipify.org?format=json",
                "https://ipinfo.io/json",
                "https://api.db-ip.com/v2/free/self"
            ];
            for (const url of urls) {
                try {
                    const res = await fetch(url);
                    if (res.ok) {
                        const data = await res.json();
                        const ip = data?.ip || data?.query;
                        if (ip) {
                            if (ip === '195.114.121.171' || ip === '5.58.213.76') {
                                setHasUnlimited(true);
                                setIsOwner(true);
                            }
                            return;
                        }
                    }
                } catch (err) {
                    console.warn(`Could not fetch IP from ${url}:`, err);
                }
            }
            console.warn("Could not retrieve IP address. Fallbacks exhausted.");
        };
        fetchIP();
        
        const baseCodes = ['CUBE-CRAFT-UNLIMITED', 'GEMINI-POWER-2024', 'TRANSLATE-ALL-THE-THINGS'];
        const provisionedCodes = JSON.parse(localStorage.getItem(LS_KEYS.PROVISIONED) || '[]');
        setActivationCodes([...baseCodes, ...provisionedCodes]);

    }, []);

    useEffect(() => {
        if (view === 'menu') {
            // translateScripts remains saved
            setZipHasScripts(false);
            setZipHasEncryptedScripts(false);
            setAllowTranslateEncrypted(false);
            setEncryptedScriptsCharCount(0);
        }
    }, [view]);

    const toggleDevMode = () => {
        const newDevMode = !isDevMode;
        setIsDevMode(newDevMode);
        localStorage.setItem(LS_KEYS.DEV_MODE, String(newDevMode));
    };

    const handleTranslationSuccess = () => {
        if (hasUnlimited) return;
        const newCount = usageCount + 1;
        setUsageCount(newCount);
        localStorage.setItem(LS_KEYS.USAGE, newCount.toString());
    };

    const handleProvision = (newKey: string) => {
        const currentProvisioned = JSON.parse(localStorage.getItem(LS_KEYS.PROVISIONED) || '[]');
        const updatedProvisioned = [...currentProvisioned, newKey];
        localStorage.setItem(LS_KEYS.PROVISIONED, JSON.stringify(updatedProvisioned));
        setActivationCodes(prev => [...prev, newKey]);
    };

    const handleActivate = (code: string): 'unlimited' | 'attempts_added' | 'invalid' | 'promo_used' | 'api_key_entered' => {
        const cleanCode = code.trim().toUpperCase();

        if (cleanCode.startsWith('AIZA')) {
            return 'api_key_entered';
        }

        const secretInfinKey = SECRETS.infinKey.toUpperCase();
        if (cleanCode === secretInfinKey) {
            localStorage.setItem(LS_KEYS.UNLIMITED, 'true');
            setHasUnlimited(true);
            return 'unlimited';
        }

        if (cleanCode === SECRETS.superKey) {
            localStorage.setItem(LS_KEYS.UNLIMITED, 'true');
            setHasUnlimited(true);
            setSpecialView(true);
            setIsOwner(true);
            return 'unlimited';
        }

        if (cleanCode === SECRETS.adminNick) {
            if (hasUnlimited) return 'invalid';
            const usedPromos: string[] = JSON.parse(localStorage.getItem(LS_KEYS.PROMO_CODES_USED) || '[]');
            if (usedPromos.includes(cleanCode)) {
                return 'promo_used';
            }
            
            const newCount = usageCount - 5; // Subtracting from usage count adds attempts
            setUsageCount(newCount);
            localStorage.setItem(LS_KEYS.USAGE, newCount.toString());
            
            usedPromos.push(cleanCode);
            localStorage.setItem(LS_KEYS.PROMO_CODES_USED, JSON.stringify(usedPromos));
            
            return 'attempts_added';
        }

        const usedCodes: string[] = JSON.parse(localStorage.getItem(LS_KEYS.ACTIVATION_CODES_USED) || '[]');
        
        if (activationCodes.includes(cleanCode) && !usedCodes.includes(cleanCode)) {
            localStorage.setItem(LS_KEYS.UNLIMITED, 'true');
            setHasUnlimited(true);
            
            usedCodes.push(cleanCode);
            localStorage.setItem(LS_KEYS.ACTIVATION_CODES_USED, JSON.stringify(usedCodes));
            
            return 'unlimited';
        }
        return 'invalid';
    };
    
    // --- Timer Management for Background Processing ---
    useEffect(() => {
        if (autoTranslationState.processingState === ProcessingState.PROCESSING) {
            autoTimerRef.current = window.setInterval(() => setAutoTranslationState(prev => ({...prev, elapsedTime: prev.elapsedTime + 1})), 1000);
        } else if (autoTimerRef.current) { clearInterval(autoTimerRef.current); autoTimerRef.current = null; }
        return () => { if (autoTimerRef.current) clearInterval(autoTimerRef.current); };
    }, [autoTranslationState.processingState]);

    useEffect(() => {
        if (apiTranslationState.processingState === ProcessingState.PROCESSING) {
            apiTimerRef.current = window.setInterval(() => setApiTranslationState(prev => ({...prev, elapsedTime: prev.elapsedTime + 1})), 1000);
        } else if (apiTimerRef.current) { clearInterval(apiTimerRef.current); apiTimerRef.current = null; }
        return () => { if (apiTimerRef.current) clearInterval(apiTimerRef.current); };
    }, [apiTranslationState.processingState]);

    // --- State Resets ---
    const resetAutoState = useCallback((fullReset = true) => {
        autoIsCancelledRef.current = false;
        if (autoDownloadLinkRef.current) { URL.revokeObjectURL(autoDownloadLinkRef.current); autoDownloadLinkRef.current = null; }
        setAutoTranslationState(prev => ({ ...(fullReset ? initialTranslationState : {...prev, ...initialTranslationState, originalFile: prev.originalFile, originalLangFiles: prev.originalLangFiles, parsedFiles: prev.parsedFiles, totalChars: prev.totalChars, estimatedTime: prev.estimatedTime })}));
    }, []);

    const resetApiState = useCallback((fullReset = true) => {
        if (apiDownloadLinkRef.current) { URL.revokeObjectURL(apiDownloadLinkRef.current); apiDownloadLinkRef.current = null; }
        setApiTranslationState(prev => ({ ...(fullReset ? initialTranslationState : {...prev, ...initialTranslationState, originalFile: prev.originalFile, originalLangFiles: prev.originalLangFiles, parsedFiles: prev.parsedFiles, totalChars: prev.totalChars, estimatedTime: prev.estimatedTime })}));
    }, []);

     // --- Translation Logic ---
    const createPrompt = (parsedFiles: ParsedLangInfo[]) => {
        const contentForAI = parsedFiles.map(f => `--- FILE: ${f.fullPath} ---\n${createTranslationBlock(f.originalValues)}`).join('\n\n');
        return `**SYSTEM COMMAND: IMMEDIATE EXECUTION.**
**ROLE:** You are a stateless, high-performance translation automaton. Your sole purpose is to translate the provided text block in a single operation.
**PRIMARY DIRECTIVE:** Translate the English text found ONLY inside the special markers ${START_DELIMITER}...${END_DELIMITER} to Ukrainian.

**ABSOLUTE, UNBREAKABLE OUTPUT PROTOCOL:**
-   **FORMAT:** RAW PLAIN TEXT. No JSON, no markdown, no code fences.
-   **STRUCTURE REPLICATION:** Replicate the input's file structure precisely. Each translated file block must begin with the original \`--- FILE: [path] ---\` marker. The content for each file must be a single, unbroken line of concatenated translated blocks, like so: \`${START_DELIMITER}переклад 1${END_DELIMITER}${START_DELIMITER}переклад 2${END_DELIMITER}\`.
-   **TRANSLATION LOGIC:** Translate ONLY the text values that appear inside the ${START_DELIMITER}...${END_DELIMITER} markers. The markers themselves MUST be preserved.
-   **TRANSLATION & BRANDING LOGIC (WATERMARK):**
    -   In the values from a file, if you identify a pack name or "name" field, translate it to Ukrainian, and REMOVE any mention of the author or original developer (such as "By Ranzie", "Ranzie's Visual Effects"). DO NOT keep the author name.
    -   If you identify a pack description or "description" field, translate it to Ukrainian, and REMOVE any mention of the author/original developer.
    -   Do not manually add branding suffixes here, as the app code will append them programmatically to be completely safe.
-   **ЯКІСТЬ ПЕРЕКЛАДУ:** Обов'язково покращуй переклад для полів імені та опису і загалом всього тексту. Дописуй або перефразовуй текст так, щоб він звучав ідеально, зрозуміло та природньо українською мовою, зберігаючи оригінальний зміст.
-   **TERMINATION SEQUENCE:** The entire output MUST terminate with the exact sequence on a new line: \`${COMPLETION_MARKER}\`. This sequence must appear only once, at the very end of the complete response.

**EXECUTE.**

--- **INPUT DATA** ---
${contentForAI}`;
    }
    
    const processApiResponse = async (fullTranslation: string, parsedFiles: ParsedLangInfo[], originalFile: File | null, originalLangFiles: LangFileInfo[], addStep: (msg: string) => void, originalFileName?: string | null, extraTranslations?: Record<string, string>) => {
        addStep('Обробка та збірка перекладу...');
        const translations: Record<string, string> = {};
        const fileSections = fullTranslation.trim().split(/--- FILE: (.*?) ---/s);
        let allCountsMatch = true;

        for (let i = 1; i < fileSections.length; i += 2) {
            const path = fileSections[i].trim();
            const contentBlock = fileSections[i+1].trim();
            const parsedInfo = parsedFiles.find(f => f.fullPath === path);
            if (parsedInfo) {
                const translatedValues = parseTranslationBlock(contentBlock);
                if (translatedValues.length !== parsedInfo.originalValues.length) {
                    allCountsMatch = false;
                    console.error(`CRITICAL for ${path}: Mismatch in translation count. Expected ${parsedInfo.originalValues.length}, got ${translatedValues.length}.`);
                    throw new Error(`Помилка цілісності відповіді від ШІ для файлу ${path}. Очікувалось ${parsedInfo.originalValues.length} блоків, отримано ${translatedValues.length}. Спробуйте ще раз.`);
                }
                translations[path] = rebuildAnyFile(path, parsedInfo.skeleton, parsedInfo.originalValues, translatedValues);
            }
        }

        if (extraTranslations) {
            Object.assign(translations, extraTranslations);
        }
        
        // Handle Telegram Mini App logic
        if (isTelegram) {
            addStep("Підготовка файлів для скачування через браузер...");
            localStorage.setItem('telegram_translations', JSON.stringify(translations));
            localStorage.setItem('telegram_filename', originalFile?.name || originalFileName || "addon.mcaddon");
            
            const downloadUrl = "https://sirvalentin39-dotcom.github.io/sirvalentin39/download.html";
            
            const tg = (window as any).Telegram?.WebApp;
            if (tg && typeof tg.openLink === 'function') {
                tg.openLink(downloadUrl);
            } else {
                window.open(downloadUrl, '_blank');
            }
            return "telegram_redirect";
        }

        addStep("Застосування всіх перекладів...");
        if (!originalFile) throw new Error("Вихідний файл відсутній для застосування перекладу на клієнті.");
        const zip = await JSZip.loadAsync(originalFile);
        const processedZip = await applyTranslations(zip, translations, originalLangFiles);

        addStep("Перепакування перекладеного доповнення...");
        const blob = await processedZip.generateAsync({ type: 'blob', mimeType: 'application/octet-stream' });
        return URL.createObjectURL(blob);
    };

    const handleAutoTranslate = async () => {
        const { originalFile, parsedFiles, totalChars, originalFileName } = autoTranslationState;
        const fileLoaded = isTelegram ? !!originalFileName : !!originalFile;
        if (!fileLoaded || parsedFiles.length === 0) {
            setAutoTranslationState(prev => ({...prev, errorMessage: "Файл не завантажено або не знайдено мовних файлів.", processingState: ProcessingState.ERROR}));
            return;
        }
        resetAutoState(false);
        setAutoTranslationState(prev => ({...prev, processingState: ProcessingState.PROCESSING }));
        
        const addStep = (message: string) => setAutoTranslationState(prev => ({...prev, statusSteps: [...prev.statusSteps, message], currentStep: prev.currentStep + 1}));
        
        try {
            if (autoIsCancelledRef.current) return;
            addStep(`Сканування завершено: знайдено ${parsedFiles.length} файлів.`);

            const chatFn = async (p: string): Promise<string> => {
                if (autoIsCancelledRef.current) throw new Error("Cancelled");
                if (isDevMode || isOwner) {
                    setAiLogs(prev => [...prev, { direction: 'request', model: 'google/gemini-3.1-flash-lite', timestamp: new Date().toISOString(), content: p }]);
                }
                try {
                    const response = await puter.ai.chat(p, { model: 'google/gemini-3.1-flash-lite' });
                    if (autoIsCancelledRef.current) throw new Error("Cancelled");
                    if (!response.message || !response.message.content) throw new Error("Недійсна відповідь від сервісу ШІ.");
                    if (isDevMode || isOwner) {
                        setAiLogs(prev => [...prev, { direction: 'response', model: 'google/gemini-3.1-flash-lite', timestamp: new Date().toISOString(), content: response.message.content }]);
                    }
                    return response.message.content;
                } catch (error: any) {
                    const msg = (error?.error?.message || error?.message || '').toLowerCase();
                    if (msg.includes('permission denied') || msg.includes('rate limit') || msg.includes('ліміту запитів')) {
                         throw new Error("Досягнуто ліміту запитів. Спробуйте пізніше або використайте режим з API ключем.");
                    }
                    throw error;
                }
            };

            let localAllowEncrypt = allowTranslateEncrypted;
            if (translateScripts && !allowTranslateEncrypted && (autoTranslationState.scriptsThatAreEncryptedAndNeedTranslation?.length ?? 0) > 0) {
                const userChoice = await askForEncryptedPermission();
                if (userChoice) {
                    setAllowTranslateEncrypted(true);
                    localAllowEncrypt = true;
                } else {
                    setAllowTranslateEncrypted(false);
                    localAllowEncrypt = false;
                    addStep("Користувач відмовився від зашифрованих скриптів. Вони залишаться без змін.");
                }
            }

            let filesForStandardTranslation: ParsedLangInfo[] = parsedFiles.filter(f => !f.fullPath.endsWith('.js'));
            let isolatedJsTranslations: Record<string, string> = { ...(autoTranslationState.isolatedJsTranslations || {}) };
            
            if (translateScripts) {
                filesForStandardTranslation.push(...(autoTranslationState.scriptsThatNeedTranslation || []));
                
                if (localAllowEncrypt && autoTranslationState.scriptsThatAreEncryptedAndNeedTranslation) {
                    for (const file of autoTranslationState.scriptsThatAreEncryptedAndNeedTranslation) {
                        if (autoIsCancelledRef.current) return;
                        addStep(`Аналіз зашифрованого файлу: ${file.fullPath.split('/').pop()} за допомогою головного ШІ (Gemini)...`);
                        const checkPrompt = `Ти головна модель ШІ. Твоя модель: Gemini.
Проаналізуй цей зашифрований/обфускований код і визнач, чи є в ньому зашифровані/приховані текстові рядки для перекладу на українську мову (наприклад, діалоги, назви предметів чи повідомлення гравцеві).
Поверни слово 'YES', якщо в коді є текст для перекладу, та 'NO', якщо тексту немає або код повністю технічний.
Поверни ТІЛЬКИ одне слово 'YES' або 'NO' без будь-яких зайвих пояснень чи маркдауну.

Код:
${file.skeleton[0]?.content ?? ''}`;

                        try {
                            const checkResp = await chatFn(checkPrompt);
                            const hasTranslatable = checkResp.trim().toUpperCase().includes('YES');
                            
                            if (hasTranslatable) {
                                if (autoIsCancelledRef.current) return;
                                addStep(`Знайдено зашифрований текст у ${file.fullPath.split('/').pop()}. Починаємо переклад цілого файлу з збереженням структури...`);
                                const transPrompt = `Ти головна ШІ модель. Твоє завдання — перекласти ТІЛЬКИ нові текстові повідомлення, рядки, діалоги та юнікод-тексти всередині зашифрованого/обфускованого файлу ${file.fullPath} українською мовою. 
Код, його структуру, змінні, методи, цифри, технічні символи, регулярні вирази та обфускацію залиш на 100% ОДНАКОВИМИ. Текст має залишатися на своїх місцях у коді.
УВАГА: Поверни тільки чистий готовий код. Ніяких пояснень, markdown блоків чи маркерів, тільки чистий код скрипту!

Код:
${file.skeleton[0]?.content ?? ''}`;
                                
                                const translatedCode = await chatFn(transPrompt);
                                const cleanedCode = translatedCode.replace(/```(?:js|javascript)?/gi, '').replace(/```/g, '').trim();
                                isolatedJsTranslations[file.fullPath] = cleanedCode;
                                addStep(`Успішно перекладено зашифрований файл: ${file.fullPath.split('/').pop()}`);
                            } else {
                                addStep(`Тексту для перекладу не знайдено в зашифрованому файлі: ${file.fullPath.split('/').pop()}`);
                                isolatedJsTranslations[file.fullPath] = file.skeleton[0]?.content ?? '';
                            }
                        } catch (err) {
                            console.warn("Error processing encrypted file in auto mode:", err);
                            addStep(`Помилка перевірки зашифрованого файлу, пропускаємо: ${file.fullPath.split('/').pop()}`);
                            isolatedJsTranslations[file.fullPath] = file.skeleton[0]?.content ?? '';
                        }
                    }
                } else if (autoTranslationState.scriptsThatAreEncryptedAndNeedTranslation) {
                    for (const file of autoTranslationState.scriptsThatAreEncryptedAndNeedTranslation) {
                        isolatedJsTranslations[file.fullPath] = file.skeleton[0]?.content ?? '';
                    }
                }
            } else {
                isolatedJsTranslations = {};
            }

            if (autoIsCancelledRef.current) return;

            if (filesForStandardTranslation.length === 0) {
                addStep("Усі файли оброблено (без стандартного перекладу).");
                const url = await processApiResponse(COMPLETION_MARKER, [], autoTranslationState.originalFile, autoTranslationState.originalLangFiles, addStep, autoTranslationState.originalFileName, isolatedJsTranslations);
                autoDownloadLinkRef.current = url;
                setAutoTranslationState(prev => ({...prev, downloadLink: url, processingState: ProcessingState.DONE}));
                handleTranslationSuccess();
                return;
            }

            const prompt = createPrompt(filesForStandardTranslation);
            setAutoTranslationState(prev => ({...prev, debugPrompt: prompt}));
            
            if (autoIsCancelledRef.current) return;
            const charsToTranslate = filesForStandardTranslation.reduce((acc, f) => acc + f.originalValues.join('').length, 0);
            addStep(`Надсилання ${charsToTranslate.toLocaleString('uk-UA')} символів до ШІ...`);
            
            const rawResponse = await chatFn(prompt);

            if (autoIsCancelledRef.current) return;
            setAutoTranslationState(prev => ({...prev, debugResponse: rawResponse}));
            
            if (autoIsCancelledRef.current) return;
            addStep(`Отримано відповідь від ШІ (${rawResponse.length.toLocaleString('uk-UA')} символів).`);
            
            if (!rawResponse.includes(COMPLETION_MARKER)) console.warn("AI response might be incomplete as completion marker was not found.");
            
            if (autoIsCancelledRef.current) return;
            const url = await processApiResponse(rawResponse, filesForStandardTranslation, autoTranslationState.originalFile, autoTranslationState.originalLangFiles, addStep, autoTranslationState.originalFileName, isolatedJsTranslations);
            
            if (autoIsCancelledRef.current) return;
            autoDownloadLinkRef.current = url;
            setAutoTranslationState(prev => ({...prev, downloadLink: url, processingState: ProcessingState.DONE}));
            handleTranslationSuccess();
        } catch (error: any) {
            if (autoIsCancelledRef.current) return;
            console.error(error);
            const errorMessageText = error?.message === "Cancelled" ? "Переклад було успішно скасовано." : error.message || 'Сталася невідома помилка.';
            setAutoTranslationState(prev => ({...prev, errorMessage: errorMessageText, debugResponse: errorMessageText, processingState: ProcessingState.ERROR}));
        }
    };
    
    const handleApiTranslate = async (selectedModel: string) => {
        const { originalFile, parsedFiles, totalChars, originalLangFiles, originalFileName } = apiTranslationState;
        
        const storedKeys = JSON.parse(localStorage.getItem(LS_KEYS.API_KEYS_LIST) || '[]');
        const activeKeyId = localStorage.getItem(LS_KEYS.ACTIVE_API_KEY_ID);
        const activeKey = storedKeys.find((k: ApiKey) => k.id === activeKeyId);
        
        if (!activeKey) { setApiTranslationState(prev => ({...prev, errorMessage: "Активний API ключ не вибрано. Перейдіть до керування ключами.", processingState: ProcessingState.ERROR})); return; }
        
        const fileLoaded = isTelegram ? !!originalFileName : !!originalFile;
        if (!fileLoaded || parsedFiles.length === 0) { setApiTranslationState(prev => ({...prev, errorMessage: "Файл не завантажено або не знайдено мовних файлів.", processingState: ProcessingState.ERROR})); return; }
        
        resetApiState(false);
        apiIsCancelledRef.current = false;
        setApiTranslationState(prev => ({ ...prev, processingState: ProcessingState.PROCESSING }));
        
        const addStep = (message: string) => setApiTranslationState(prev => ({ ...prev, statusSteps: [...prev.statusSteps, message], currentStep: prev.currentStep + 1 }));

        try {
            const ai = new GoogleGenAI({ apiKey: activeKey.key });
            addStep(`Сканування завершено: знайдено ${parsedFiles.length} файлів.`);

            const chatFn = async (p: string): Promise<string> => {
                if (apiIsCancelledRef.current) throw new Error("Cancelled");
                if (isDevMode || isOwner) {
                    setAiLogs(prev => [...prev, { direction: 'request', model: selectedModel, timestamp: new Date().toISOString(), content: p }]);
                }
                const response = await ai.models.generateContent({ model: selectedModel, contents: p });
                if (apiIsCancelledRef.current) throw new Error("Cancelled");
                if (isDevMode || isOwner) {
                    setAiLogs(prev => [...prev, { direction: 'response', model: selectedModel, timestamp: new Date().toISOString(), content: response.text ?? '' }]);
                }
                return response.text ?? '';
            };

            let localAllowEncrypt = allowTranslateEncrypted;
            if (translateScripts && !allowTranslateEncrypted && (apiTranslationState.scriptsThatAreEncryptedAndNeedTranslation?.length ?? 0) > 0) {
                const userChoice = await askForEncryptedPermission();
                if (userChoice) {
                    setAllowTranslateEncrypted(true);
                    localAllowEncrypt = true;
                } else {
                    setAllowTranslateEncrypted(false);
                    localAllowEncrypt = false;
                    addStep("Користувач відмовився від зашифрованих скриптів. Вони залишаться без змін.");
                }
            }

            let filesForStandardTranslation: ParsedLangInfo[] = parsedFiles.filter(f => !f.fullPath.endsWith('.js'));
            let isolatedJsTranslations: Record<string, string> = { ...(apiTranslationState.isolatedJsTranslations || {}) };
            
            if (translateScripts) {
                filesForStandardTranslation.push(...(apiTranslationState.scriptsThatNeedTranslation || []));
                
                if (localAllowEncrypt && apiTranslationState.scriptsThatAreEncryptedAndNeedTranslation) {
                    for (const file of apiTranslationState.scriptsThatAreEncryptedAndNeedTranslation) {
                        addStep(`Аналіз зашифрованого файлу: ${file.fullPath.split('/').pop()} за допомогою головного ШІ (${selectedModel})...`);
                        const checkPrompt = `Ти головна модель ШІ. Твоя модель: ${selectedModel}.
Проаналізуй цей зашифрований/обфускований код і визнач, чи є в ньому зашифровані/приховані текстові рядки для перекладу на українську мову (наприклад, діалоги, назви предметів чи повідомлення гравцеві).
Поверни слово 'YES', якщо в коді є text для перекладу, та 'NO', якщо тексту немає або код повністю технічний.
Поверни ТІЛЬКИ одне слово 'YES' або 'NO' без будь-яких зайвих пояснень чи маркдауну.

Код:
${file.skeleton[0]?.content ?? ''}`;

                        try {
                            const checkResp = await chatFn(checkPrompt);
                            const hasTranslatable = checkResp.trim().toUpperCase().includes('YES');
                            
                            if (hasTranslatable) {
                                addStep(`Знайдено зашифрований текст у ${file.fullPath.split('/').pop()}. Починаємо переклад цілого файлу з збереженням структури...`);
                                const transPrompt = `Ти головна ШІ модель. Твоє завдання — перекласти ТІЛЬКИ нові текстові повідомлення, рядки, діалоги та юнікод-тексти всередині зашифрованого/обфускованого файлу ${file.fullPath} українською мовою. 
Код, його структуру, змінні, методи, цифри, технічні символи, регулярні вирази та обфускацію залиш на 100% ОДНАКОВИМИ. Текст має залишатися на своїх місцях у коді.
УВАГА: Поверни только чистий готовий код. Ніяких пояснень, markdown блоків чи маркерів, тільки чистий код скрипту!

Код:
${file.skeleton[0]?.content ?? ''}`;
                                
                                const translatedCode = await chatFn(transPrompt);
                                const cleanedCode = translatedCode.replace(/```(?:js|javascript)?/gi, '').replace(/```/g, '').trim();
                                isolatedJsTranslations[file.fullPath] = cleanedCode;
                                addStep(`Успішно перекладено зашифрований файл: ${file.fullPath.split('/').pop()}`);
                            } else {
                                addStep(`Тексту для перекладу не знайдено в зашифрованому файлі: ${file.fullPath.split('/').pop()}`);
                                isolatedJsTranslations[file.fullPath] = file.skeleton[0]?.content ?? '';
                            }
                        } catch (err) {
                            console.warn("Error processing encrypted file via selected API model:", err);
                            addStep(`Помилка перевірки зашифрованого файлу, пропускаємо: ${file.fullPath.split('/').pop()}`);
                            isolatedJsTranslations[file.fullPath] = file.skeleton[0]?.content ?? '';
                        }
                    }
                } else if (apiTranslationState.scriptsThatAreEncryptedAndNeedTranslation) {
                    for (const file of apiTranslationState.scriptsThatAreEncryptedAndNeedTranslation) {
                        isolatedJsTranslations[file.fullPath] = file.skeleton[0]?.content ?? '';
                    }
                }
            } else {
                isolatedJsTranslations = {};
            }

            if (filesForStandardTranslation.length === 0) {
                addStep("Усі файли оброблено (без стандартного перекладу).");
                const url = await processApiResponse(COMPLETION_MARKER, [], originalFile, originalLangFiles, addStep, originalFileName, isolatedJsTranslations);
                apiDownloadLinkRef.current = url;
                setApiTranslationState(prev => ({...prev, downloadLink: url, processingState: ProcessingState.DONE}));
                handleTranslationSuccess();
                return;
            }

            const initialPrompt = createPrompt(filesForStandardTranslation);
            setApiTranslationState(prev => ({...prev, debugPrompt: initialPrompt}));

            let fullTranslation = ""; let isComplete = false; let attempts = 0; const MAX_ATTEMPTS = 5;
            let currentPrompt = initialPrompt;

            const currentChars = filesForStandardTranslation.reduce((acc, f) => acc + f.originalValues.join('').length, 0);

            while (!isComplete && attempts < MAX_ATTEMPTS) {
                attempts++;
                addStep(attempts === 1 ? `Надсилання ${currentChars.toLocaleString('uk-UA')} символів до ШІ...` : `Відповідь ШІ неповна. Продовження (спроба ${attempts}/${MAX_ATTEMPTS})...`);
                
                const partialTranslation = await chatFn(currentPrompt);
                addStep(`Отримано відповідь від ШІ (${partialTranslation.length.toLocaleString('uk-UA')} символів).`);
                
                fullTranslation += partialTranslation.replace(COMPLETION_MARKER, "");
                if (partialTranslation.includes(COMPLETION_MARKER)) isComplete = true;
                else currentPrompt = `IMPERATIVE COMMAND: Your previous response was incomplete. Provide ONLY the continuation of the translation. Your response must follow all original rules, including the structure and the final completion marker. Here is the COMPLETE translation you have generated so far for context (DO NOT repeat it): \n${fullTranslation}\n\nContinue translating from exactly where you left off from the ORIGINAL input data.`;
            }
            if (!isComplete) throw new Error(`Не вдалося отримати повний переклад від ШІ після ${MAX_ATTEMPTS} спроб.`);
            
            setApiTranslationState(prev => ({...prev, debugResponse: fullTranslation}));
            
            const url = await processApiResponse(fullTranslation, filesForStandardTranslation, originalFile, originalLangFiles, addStep, originalFileName, isolatedJsTranslations);
            apiDownloadLinkRef.current = url;
            setApiTranslationState(prev => ({...prev, downloadLink: url, processingState: ProcessingState.DONE}));
            handleTranslationSuccess();
        } catch (error: any) {
            if (apiIsCancelledRef.current) return;
            console.error(error);
            const errorMessageText = error?.message === "Cancelled" ? "Переклад було успішно скасовано." : error.message || 'Сталася невідома помилка.';
            setApiTranslationState(prev => ({...prev, errorMessage: errorMessageText, debugResponse: errorMessageText, processingState: ProcessingState.ERROR}));
        }
    };


    const renderView = () => {
        switch (view) {
            case 'auto_with_api': return <AutoTranslatorWithApi setView={setView} isDevMode={isDevMode} isOwner={isOwner} translationState={apiTranslationState} setTranslationState={setApiTranslationState} handleTranslate={handleApiTranslate} resetState={resetApiState} translateScripts={translateScripts} setTranslateScripts={setTranslateScripts} zipHasScripts={zipHasScripts} setZipHasScripts={setZipHasScripts} zipHasEncryptedScripts={zipHasEncryptedScripts} setZipHasEncryptedScripts={setZipHasEncryptedScripts} allowTranslateEncrypted={allowTranslateEncrypted} setAllowTranslateEncrypted={setAllowTranslateEncrypted} aiLogs={aiLogs} setAiLogs={setAiLogs} encryptedScriptsCharCount={encryptedScriptsCharCount} setEncryptedScriptsCharCount={setEncryptedScriptsCharCount} handleCancel={() => {
                apiIsCancelledRef.current = true;
                setApiTranslationState(prev => ({
                    ...prev,
                    processingState: ProcessingState.ERROR,
                    errorMessage: "Переклад було успішно скасовано.",
                    statusSteps: [...prev.statusSteps, "Скасування перекладу користувачем."]
                }));
            }} isLimitReached={isLimitReached} setShowBuyAttemptsModal={setShowBuyAttemptsModal} />;
            case 'auto': return <AutoTranslator setView={setView} isDevMode={isDevMode} isOwner={isOwner} translationState={autoTranslationState} setTranslationState={setAutoTranslationState} handleTranslate={handleAutoTranslate} resetState={resetAutoState} translateScripts={translateScripts} setTranslateScripts={setTranslateScripts} zipHasScripts={zipHasScripts} setZipHasScripts={setZipHasScripts} zipHasEncryptedScripts={zipHasEncryptedScripts} setZipHasEncryptedScripts={setZipHasEncryptedScripts} allowTranslateEncrypted={allowTranslateEncrypted} setAllowTranslateEncrypted={setAllowTranslateEncrypted} handleCancel={() => {
                autoIsCancelledRef.current = true;
                setAutoTranslationState(prev => ({
                    ...prev,
                    processingState: ProcessingState.ERROR,
                    errorMessage: "Переклад було успішно скасовано.",
                    statusSteps: [...prev.statusSteps, "Скасування перекладу користувачем."]
                }));
            }} aiLogs={aiLogs} encryptedScriptsCharCount={encryptedScriptsCharCount} setEncryptedScriptsCharCount={setEncryptedScriptsCharCount} isLimitReached={isLimitReached} setShowBuyAttemptsModal={setShowBuyAttemptsModal} />;
            case 'manual': return <ManualTranslator setView={setView} onTranslationSuccess={handleTranslationSuccess} translateScripts={translateScripts} setTranslateScripts={setTranslateScripts} zipHasScripts={zipHasScripts} setZipHasScripts={setZipHasScripts} zipHasEncryptedScripts={zipHasEncryptedScripts} setZipHasEncryptedScripts={setZipHasEncryptedScripts} allowTranslateEncrypted={allowTranslateEncrypted} setAllowTranslateEncrypted={setAllowTranslateEncrypted} encryptedScriptsCharCount={encryptedScriptsCharCount} setEncryptedScriptsCharCount={setEncryptedScriptsCharCount} isDevMode={isDevMode} isOwner={isOwner} isLimitReached={isLimitReached} setShowBuyAttemptsModal={setShowBuyAttemptsModal} />;
            case 'unlimited': return <UnlimitedAccessView setView={setView} onActivate={handleActivate} userId={userId} specialView={specialView} onProvision={handleProvision} isDevMode={isDevMode} onToggleDevMode={toggleDevMode} onStartPolling={() => setIsPolling(true)} />;
            case 'admin': return <AdminControlPanel setView={setView} isDevMode={isDevMode} toggleDevMode={toggleDevMode} />;
            case 'menu': default: return <MainMenu setView={setView} usageCount={usageCount} hasUnlimited={hasUnlimited} autoStatus={autoTranslationState} apiStatus={apiTranslationState} setShowBuyAttemptsModal={setShowBuyAttemptsModal} isOwner={isOwner} isDevMode={isDevMode} toggleDevMode={toggleDevMode} />;
        }
    };
    
    if (isBanned) {
        return (
            <div className="fixed inset-0 bg-red-950 flex flex-col items-center justify-center p-6 text-center z-[10000] space-y-6">
                <div className="bg-red-900/40 p-10 rounded-3xl border-4 border-red-500 max-w-lg w-full shadow-[0_0_50px_rgba(239,68,68,0.5)] animate-pulse">
                    <span className="text-8xl block mb-4">⚠️</span>
                    <h1 className="text-4xl font-extrabold text-white tracking-wider mb-4 font-sans uppercase">ДОСТУП ЗАБЛОКОВАНО</h1>
                    <p className="text-red-200 text-base leading-relaxed font-sans font-medium">
                        Вашу IP-адресу та ідентифікатор користувача було заблоковано адміністратором системи за порушення правил використання сервісу.
                    </p>
                    <div className="mt-8 border-t border-red-500/30 pt-6">
                        <p className="font-mono text-xs text-red-400">ID Користувача: {userId || 'Невідомий'}</p>
                        <p className="text-red-300 text-sm mt-3 font-semibold font-sans">Спроби подальшого обходу або злам системи призведуть до постійної заборони доступу.</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-brand-background">
            <div className="w-full max-w-2xl mx-auto flex flex-col">
                <HeaderInfo 
                    usageCount={usageCount} 
                    hasUnlimited={hasUnlimited} 
                    userId={userId} 
                    setView={setView} 
                    isOwner={isOwner} 
                    isDevMode={isDevMode} 
                    toggleDevMode={() => setIsDevMode(prev => !prev)} 
                />
                <div className="bg-brand-surface rounded-2xl shadow-2xl p-6 md:p-8 flex-grow">
                     {renderView()}
                </div>
            </div>
            <PermissionModal 
                isOpen={encryptedConfirmModal?.isOpen ?? false} 
                onAllow={() => encryptedConfirmModal?.resolve(true)} 
                onDecline={() => encryptedConfirmModal?.resolve(false)} 
            />
            <BuyAttemptsModal 
                isOpen={showBuyAttemptsModal} 
                onClose={() => setShowBuyAttemptsModal(false)} 
                onGoToPayment={() => {
                    setShowBuyAttemptsModal(false);
                    setView('unlimited');
                }}
            />
        </div>
    );
}

const BuyAttemptsModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onGoToPayment: () => void;
}> = ({ isOpen, onClose, onGoToPayment }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 animate-fade-in select-none">
            <div className="bg-brand-surface border-2 border-purple-500/40 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl animate-scale-up text-left">
                <div className="flex items-center gap-3 border-b border-gray-800 pb-3">
                    <div className="bg-purple-500/20 p-2.5 rounded-full border border-purple-500/40">
                        <SparklesIcon className="w-6 h-6 text-purple-400" />
                    </div>
                    <div>
                        <h3 className="text-lg font-black text-gray-100 tracking-wide uppercase">Спроби вичерпано</h3>
                        <p className="text-xs text-purple-400 font-semibold uppercase tracking-wider">Придбайте більше спроб</p>
                    </div>
                </div>

                <div className="space-y-3 text-sm leading-relaxed text-gray-300">
                    <p>
                        Ви використали всі безкоштовні спроби перекладу на сьогодні.
                    </p>
                    <p className="bg-purple-950/20 border border-purple-800/40 p-3 rounded-xl">
                        Ви можете придбати ще <strong className="text-yellow-400 font-extrabold">+5 додаткових спроб за 50 грн</strong> або активувати необмежений доступ <strong className="text-teal-400 font-extrabold">за 200 грн</strong>.
                    </p>
                    <p className="text-xs text-gray-400">
                        Оплата здійснюється на офіційну банку Monobank. Після оплати ваша заявка перевіряється, і ви зможете продовжити роботу без обмежень. Оплата не видає ніяких ключів!
                    </p>
                </div>

                <div className="flex flex-col gap-2 pt-2">
                    <button 
                        onClick={onGoToPayment}
                        className="w-full bg-purple-600 hover:bg-purple-700 active:scale-[0.98] text-white font-bold py-3 px-4 rounded-xl transition-all shadow-lg shadow-purple-900/40 uppercase tracking-wider text-xs cursor-pointer text-center"
                    >
                        💳 Перейти до оплати та активації
                    </button>
                    <button 
                        onClick={onClose}
                        className="w-full bg-gray-800 hover:bg-gray-700 active:scale-[0.98] text-gray-400 hover:text-white font-bold py-2.5 px-4 rounded-xl transition-all uppercase tracking-wider text-xs cursor-pointer text-center"
                    >
                        Скасувати
                    </button>
                </div>
            </div>
        </div>
    );
};
