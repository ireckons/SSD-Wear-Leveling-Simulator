// ═══════════════════════════════════════════════════
// KeyVault — Access Key Management System
// Main Application Logic
// ═══════════════════════════════════════════════════

import { db, auth } from './firebase-config.js';
import {
    collection, addDoc, getDocs, doc, updateDoc, deleteDoc,
    query, orderBy, onSnapshot, Timestamp, where
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
    signInWithEmailAndPassword, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// ─── State ───
let currentKey = '';
let allKeys = [];
let currentFilter = 'all';
let currentSearch = '';
let extendDocId = null;
let renewDocId = null;
let unsubscribe = null;

// ─── DOM Elements ───
const $ = (id) => document.getElementById(id);

const authScreen = $('authScreen');
const appContainer = $('appContainer');
const loginForm = $('loginForm');
const loginBtn = $('loginBtn');
const logoutBtn = $('logoutBtn');
const generateKeyBtn = $('generateKeyBtn');
const copyKeyBtn = $('copyKeyBtn');
const saveKeyBtn = $('saveKeyBtn');
const keyDisplay = $('keyDisplay');
const userName = $('userName');
const keyDuration = $('keyDuration');
const customDurationGroup = $('customDurationGroup');
const customDuration = $('customDuration');
const keysTableBody = $('keysTableBody');
const emptyState = $('emptyState');
const searchInput = $('searchInput');
const refreshBtn = $('refreshBtn');
const exportBtn = $('exportBtn');
const headerTime = $('headerTime');

// Stats
const statTotal = $('statTotal');
const statActive = $('statActive');
const statExpired = $('statExpired');
const statRevoked = $('statRevoked');

// Modals
const extendModal = $('extendModal');
const renewModal = $('renewModal');

// ═══════════════════════════════════════════════════
// KEY GENERATION — Amazon Gift Card Format
// Format: XXXX-XXXX-XXXX-XX (14 characters + dashes)
// ═══════════════════════════════════════════════════

function generateAccessKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars: 0,O,1,I
    let key = '';
    
    for (let i = 0; i < 14; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    // Format: XXXX-XXXX-XXXX-XX
    return `${key.slice(0, 4)}-${key.slice(4, 8)}-${key.slice(8, 12)}-${key.slice(12, 14)}`;
}

// ═══════════════════════════════════════════════════
// AUTHENTICATION
// ═══════════════════════════════════════════════════

onAuthStateChanged(auth, (user) => {
    if (user) {
        authScreen.style.display = 'none';
        appContainer.classList.add('active');
        initDashboard();
    } else {
        authScreen.style.display = 'flex';
        appContainer.classList.remove('active');
        if (unsubscribe) unsubscribe();
    }
});

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('adminEmail').value;
    const password = $('adminPassword').value;
    
    loginBtn.innerHTML = '<span class="spinner"></span> Signing in...';
    loginBtn.disabled = true;
    
    try {
        await signInWithEmailAndPassword(auth, email, password);
        showToast('Welcome back, Admin!', 'success');
    } catch (error) {
        console.error('Auth error:', error);
        let msg = 'Login failed. Please check your credentials.';
        if (error.code === 'auth/invalid-credential') msg = 'Invalid email or password.';
        if (error.code === 'auth/too-many-requests') msg = 'Too many attempts. Please wait.';
        if (error.code === 'auth/invalid-api-key') msg = 'Firebase not configured. Please add your Firebase config.';
        showToast(msg, 'error');
    } finally {
        loginBtn.innerHTML = '<span>Sign In to Dashboard</span>';
        loginBtn.disabled = false;
    }
});

logoutBtn.addEventListener('click', async () => {
    try {
        if (unsubscribe) unsubscribe();
        await signOut(auth);
        showToast('Logged out successfully.', 'info');
    } catch (error) {
        showToast('Logout failed.', 'error');
    }
});

// ═══════════════════════════════════════════════════
// DASHBOARD INIT
// ═══════════════════════════════════════════════════

function initDashboard() {
    startClock();
    listenToKeys();
    setupEventListeners();
}

function startClock() {
    const update = () => {
        const now = new Date();
        headerTime.textContent = now.toLocaleString('en-IN', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: true
        });
    };
    update();
    setInterval(update, 1000);
}

// ═══════════════════════════════════════════════════
// FIRESTORE — REAL-TIME LISTENER
// ═══════════════════════════════════════════════════

function listenToKeys() {
    const q = query(collection(db, 'access_keys'), orderBy('createdAt', 'desc'));
    
    unsubscribe = onSnapshot(q, (snapshot) => {
        allKeys = [];
        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            allKeys.push({ id: docSnap.id, ...data });
        });
        
        // Auto-expire keys that are past their expiry date
        autoExpireKeys();
        updateStats();
        renderTable();
    }, (error) => {
        console.error('Firestore error:', error);
        if (error.code === 'permission-denied') {
            showToast('Firestore permission denied. Check your security rules.', 'error');
        }
    });
}

async function autoExpireKeys() {
    const now = new Date();
    for (const key of allKeys) {
        if (key.status === 'active' && key.expiresAt) {
            const expiryDate = key.expiresAt.toDate ? key.expiresAt.toDate() : new Date(key.expiresAt);
            if (now > expiryDate) {
                try {
                    await updateDoc(doc(db, 'access_keys', key.id), { status: 'expired' });
                    key.status = 'expired';
                } catch (e) {
                    console.error('Auto-expire error:', e);
                }
            }
        }
    }
}

// ═══════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════

function updateStats() {
    const total = allKeys.length;
    const active = allKeys.filter(k => k.status === 'active').length;
    const expired = allKeys.filter(k => k.status === 'expired').length;
    const revoked = allKeys.filter(k => k.status === 'revoked').length;
    
    animateCounter(statTotal, total);
    animateCounter(statActive, active);
    animateCounter(statExpired, expired);
    animateCounter(statRevoked, revoked);
}

function animateCounter(el, target) {
    const current = parseInt(el.textContent) || 0;
    if (current === target) return;
    
    const step = target > current ? 1 : -1;
    const duration = 300;
    const steps = Math.abs(target - current);
    const interval = duration / steps;
    
    let count = current;
    const timer = setInterval(() => {
        count += step;
        el.textContent = count;
        if (count === target) clearInterval(timer);
    }, Math.max(interval, 20));
}

// ═══════════════════════════════════════════════════
// TABLE RENDERING
// ═══════════════════════════════════════════════════

function renderTable() {
    let filtered = [...allKeys];
    
    // Apply filter
    if (currentFilter !== 'all') {
        filtered = filtered.filter(k => k.status === currentFilter);
    }
    
    // Apply search
    if (currentSearch) {
        const s = currentSearch.toLowerCase();
        filtered = filtered.filter(k =>
            (k.userName || '').toLowerCase().includes(s) ||
            (k.key || '').toLowerCase().includes(s)
        );
    }
    
    if (filtered.length === 0) {
        keysTableBody.innerHTML = '';
        emptyState.classList.remove('hidden');
        document.querySelector('.table-wrapper').style.display = 'none';
        return;
    }
    
    emptyState.classList.add('hidden');
    document.querySelector('.table-wrapper').style.display = 'block';
    
    keysTableBody.innerHTML = filtered.map((item, index) => {
        const createdAt = formatDate(item.createdAt);
        const expiresAt = formatDate(item.expiresAt);
        const timeLeft = getTimeLeft(item.expiresAt, item.status);
        const statusClass = item.status || 'active';
        
        return `
        <tr>
            <td class="text-muted">${index + 1}</td>
            <td class="name-cell">${escapeHtml(item.userName || 'Unknown')}</td>
            <td class="key-cell">${escapeHtml(item.key || '')}</td>
            <td>${item.duration || '—'} day${item.duration !== 1 ? 's' : ''}</td>
            <td class="date-cell">${createdAt}</td>
            <td class="date-cell">
                ${expiresAt}
                ${timeLeft ? `<br><span class="countdown ${item.status === 'active' && isUrgent(item.expiresAt) ? 'urgent' : ''}">${timeLeft}</span>` : ''}
            </td>
            <td>
                <span class="status-badge ${statusClass}">
                    <span class="dot"></span>
                    ${statusClass}
                </span>
            </td>
            <td>
                <div class="action-group">
                    <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${escapeHtml(item.key)}')" title="Copy Key">📋</button>
                    ${item.status === 'active' ? `
                        <button class="btn btn-danger btn-sm" onclick="revokeKey('${item.id}')" title="Revoke">⊘</button>
                        <button class="btn btn-secondary btn-sm" onclick="openExtendModal('${item.id}', '${escapeHtml(item.userName)}')" title="Extend">🕐</button>
                    ` : ''}
                    ${item.status === 'expired' || item.status === 'revoked' ? `
                        <button class="btn btn-success btn-sm" onclick="openRenewModal('${item.id}', '${escapeHtml(item.userName)}')" title="Renew">🔄</button>
                    ` : ''}
                    <button class="btn btn-danger btn-sm" onclick="deleteKey('${item.id}')" title="Delete">🗑</button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// ═══════════════════════════════════════════════════
// KEY OPERATIONS
// ═══════════════════════════════════════════════════

// Generate Key
generateKeyBtn.addEventListener('click', () => {
    currentKey = generateAccessKey();
    keyDisplay.innerHTML = `<span class="key-text">${currentKey}</span>`;
    keyDisplay.classList.add('has-key');
    copyKeyBtn.disabled = false;
    saveKeyBtn.disabled = false;
    
    showToast('Access key generated!', 'success');
});

// Copy Key
copyKeyBtn.addEventListener('click', () => {
    if (currentKey) {
        copyToClipboard(currentKey);
    }
});

// Save Key
saveKeyBtn.addEventListener('click', async () => {
    const name = userName.value.trim();
    if (!name) {
        showToast('Please enter a user name.', 'error');
        userName.focus();
        return;
    }
    
    if (!currentKey) {
        showToast('Please generate a key first.', 'error');
        return;
    }
    
    let duration = parseInt(keyDuration.value);
    if (keyDuration.value === 'custom') {
        duration = parseInt(customDuration.value);
        if (!duration || duration < 1) {
            showToast('Please enter a valid duration.', 'error');
            customDuration.focus();
            return;
        }
    }
    
    const now = new Date();
    const expiresAt = new Date(now.getTime() + duration * 24 * 60 * 60 * 1000);
    
    saveKeyBtn.innerHTML = '<span class="spinner"></span> Saving...';
    saveKeyBtn.disabled = true;
    
    try {
        await addDoc(collection(db, 'access_keys'), {
            key: currentKey,
            userName: name,
            status: 'active',
            duration: duration,
            createdAt: Timestamp.fromDate(now),
            expiresAt: Timestamp.fromDate(expiresAt),
            activatedAt: null,
            deviceId: null
        });
        
        showToast(`Key assigned to ${name} for ${duration} days.`, 'success');
        
        // Reset form
        currentKey = '';
        userName.value = '';
        keyDisplay.innerHTML = '<span class="key-placeholder">Click "Generate Key" to create a new access key</span>';
        keyDisplay.classList.remove('has-key');
        copyKeyBtn.disabled = true;
        keyDuration.value = '7';
        customDurationGroup.classList.add('hidden');
    } catch (error) {
        console.error('Save error:', error);
        showToast('Failed to save key. Check Firestore permissions.', 'error');
    } finally {
        saveKeyBtn.innerHTML = '✓ Save & Assign Key';
        saveKeyBtn.disabled = false;
    }
});

// Revoke Key
window.revokeKey = async (docId) => {
    if (!confirm('Are you sure you want to revoke this key? The user will lose access immediately.')) return;
    
    try {
        await updateDoc(doc(db, 'access_keys', docId), { status: 'revoked' });
        showToast('Key revoked successfully.', 'info');
    } catch (error) {
        showToast('Failed to revoke key.', 'error');
    }
};

// Delete Key
window.deleteKey = async (docId) => {
    if (!confirm('Permanently delete this key? This action cannot be undone.')) return;
    
    try {
        await deleteDoc(doc(db, 'access_keys', docId));
        showToast('Key deleted.', 'info');
    } catch (error) {
        showToast('Failed to delete key.', 'error');
    }
};

// Copy to Clipboard
window.copyToClipboard = async (text) => {
    try {
        await navigator.clipboard.writeText(text);
        showToast(`Copied: ${text}`, 'success');
    } catch (err) {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast(`Copied: ${text}`, 'success');
    }
};

// ═══════════════════════════════════════════════════
// EXTEND & RENEW MODALS
// ═══════════════════════════════════════════════════

window.openExtendModal = (docId, name) => {
    extendDocId = docId;
    $('extendUserName').textContent = name;
    extendModal.classList.add('active');
};

window.openRenewModal = (docId, name) => {
    renewDocId = docId;
    $('renewUserName').textContent = name;
    renewModal.classList.add('active');
};

$('closeExtendModal').addEventListener('click', () => extendModal.classList.remove('active'));
$('cancelExtend').addEventListener('click', () => extendModal.classList.remove('active'));
$('closeRenewModal').addEventListener('click', () => renewModal.classList.remove('active'));
$('cancelRenew').addEventListener('click', () => renewModal.classList.remove('active'));

// Extend
$('confirmExtend').addEventListener('click', async () => {
    if (!extendDocId) return;
    
    const days = parseInt($('extendDuration').value);
    const keyData = allKeys.find(k => k.id === extendDocId);
    
    if (!keyData) return;
    
    const currentExpiry = keyData.expiresAt.toDate ? keyData.expiresAt.toDate() : new Date(keyData.expiresAt);
    const now = new Date();
    const baseDate = currentExpiry > now ? currentExpiry : now;
    const newExpiry = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);
    
    try {
        await updateDoc(doc(db, 'access_keys', extendDocId), {
            expiresAt: Timestamp.fromDate(newExpiry),
            duration: (keyData.duration || 0) + days,
            status: 'active'
        });
        showToast(`Subscription extended by ${days} days.`, 'success');
        extendModal.classList.remove('active');
    } catch (error) {
        showToast('Failed to extend subscription.', 'error');
    }
});

// Renew
$('confirmRenew').addEventListener('click', async () => {
    if (!renewDocId) return;
    
    const days = parseInt($('renewDuration').value);
    const now = new Date();
    const newExpiry = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    
    try {
        await updateDoc(doc(db, 'access_keys', renewDocId), {
            status: 'active',
            duration: days,
            expiresAt: Timestamp.fromDate(newExpiry),
            activatedAt: null,
            deviceId: null
        });
        showToast(`Key renewed for ${days} days.`, 'success');
        renewModal.classList.remove('active');
    } catch (error) {
        showToast('Failed to renew key.', 'error');
    }
});

// ═══════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════

function setupEventListeners() {
    // Duration selector
    keyDuration.addEventListener('change', () => {
        if (keyDuration.value === 'custom') {
            customDurationGroup.classList.remove('hidden');
            customDuration.focus();
        } else {
            customDurationGroup.classList.add('hidden');
        }
    });
    
    // Search
    searchInput.addEventListener('input', (e) => {
        currentSearch = e.target.value;
        renderTable();
    });
    
    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderTable();
        });
    });
    
    // Refresh
    refreshBtn.addEventListener('click', () => {
        showToast('Refreshed!', 'info');
    });
    
    // Export CSV
    exportBtn.addEventListener('click', exportToCSV);
    
    // Close modals on overlay click
    [extendModal, renewModal].forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('active');
        });
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            extendModal.classList.remove('active');
            renewModal.classList.remove('active');
        }
    });
}

// ═══════════════════════════════════════════════════
// CSV EXPORT
// ═══════════════════════════════════════════════════

function exportToCSV() {
    if (allKeys.length === 0) {
        showToast('No data to export.', 'error');
        return;
    }
    
    const headers = ['User Name', 'Access Key', 'Status', 'Duration (Days)', 'Created', 'Expires'];
    const rows = allKeys.map(k => [
        k.userName || '',
        k.key || '',
        k.status || '',
        k.duration || '',
        formatDate(k.createdAt),
        formatDate(k.expiresAt)
    ]);
    
    const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `keyvault_export_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    showToast('CSV exported successfully.', 'success');
}

// ═══════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════

function formatDate(timestamp) {
    if (!timestamp) return '—';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
    });
}

function getTimeLeft(timestamp, status) {
    if (!timestamp || status !== 'active') return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diff = date - now;
    
    if (diff <= 0) return 'Expired';
    
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    if (days > 0) return `${days}d ${hours}h left`;
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m left`;
}

function isUrgent(timestamp) {
    if (!timestamp) return false;
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const diff = date - new Date();
    return diff > 0 && diff < 24 * 60 * 60 * 1000; // Less than 24 hours
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ═══════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════

function showToast(message, type = 'info') {
    const container = $('toastContainer');
    const icons = { success: '✓', error: '✗', info: 'ℹ' };
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || 'ℹ'}</span>
        <span class="toast-message">${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
    `;
    
    container.appendChild(toast);
    
    // Auto-remove after 4 seconds
    setTimeout(() => {
        toast.style.animation = 'slideOutRight 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ═══════════════════════════════════════════════════
// PWA INSTALL PROMPT
// ═══════════════════════════════════════════════════

let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBanner();
});

function showInstallBanner() {
    // Don't show if already installed or dismissed recently
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if (sessionStorage.getItem('pwa-dismissed')) return;

    const banner = document.createElement('div');
    banner.className = 'pwa-install-banner';
    banner.innerHTML = `
        <img src="icons/icon-192.png" class="pwa-icon" alt="KeyVault">
        <div class="pwa-info">
            <h4>Install KeyVault</h4>
            <p>Add to home screen for app-like experience</p>
        </div>
        <button class="btn btn-primary btn-sm" id="pwaInstallBtn">Install</button>
        <button class="pwa-dismiss" id="pwaDismissBtn">✕</button>
    `;
    document.body.appendChild(banner);

    document.getElementById('pwaInstallBtn').addEventListener('click', async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            if (outcome === 'accepted') {
                showToast('KeyVault installed! Check your home screen.', 'success');
            }
            deferredPrompt = null;
        }
        banner.remove();
    });

    document.getElementById('pwaDismissBtn').addEventListener('click', () => {
        banner.remove();
        sessionStorage.setItem('pwa-dismissed', 'true');
    });
}

// Detect standalone mode
if (window.matchMedia('(display-mode: standalone)').matches) {
    console.log('Running as installed PWA');
}
