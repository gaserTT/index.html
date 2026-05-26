/* ============================================
   ScanLink - Barcode & OCR Scanner
   Main Application Logic
   ============================================ */

// ---- State Machine ----
const AppState = Object.freeze({
    IDLE: 'idle',
    SCANNING_BARCODE: 'scanning_barcode',
    SCANNING_ID: 'scanning_id',
    CONFIRMING: 'confirming',
});

// ---- Main App Class ----
class ScannerApp {
    constructor() {
        // State
        this.state = AppState.IDLE;
        this.records = [];
        this.currentBarcode = null;
        this.currentId = null;

        // Camera
        this.videoStream = null;
        this.animFrameId = null;

        // Barcode
        this.barcodeDetector = null;
        this.barcodeSupported = false;

        // OCR
        this.ocrWorker = null;
        this.ocrReady = false;
        this.isOCRBusy = false;
        this.ocrScanTimer = null;

        // Barcode scan timer
        this.barcodeScanTimer = null;

        // Audio
        this.audioCtx = null;

        // Storage key
        this.STORAGE_KEY = 'scanlink_records';
    }

    // ---- Initialization ----
    async init() {
        this.cacheDOM();
        this.bindEvents();
        this.loadFromStorage();
        this.updateTable();
        this.updateButtons();

        // Init barcode detector
        await this.initBarcodeDetector();

        // Init OCR in background
        this.initOCR();
    }

    cacheDOM() {
        // Camera
        this.video = document.getElementById('camera-feed');
        this.canvas = document.getElementById('capture-canvas');
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        this.cameraPlaceholder = document.getElementById('camera-placeholder');
        this.scanOverlay = document.getElementById('scan-overlay');
        this.successFlash = document.getElementById('success-flash');

        // State
        this.stateIndicator = document.getElementById('state-indicator');
        this.stateText = document.getElementById('state-text');
        this.stateDot = document.getElementById('state-dot');
        this.stateMode = document.getElementById('state-mode');

        // Current scan
        this.currentScanEl = document.getElementById('current-scan');
        this.barcodeField = document.getElementById('barcode-field');
        this.idField = document.getElementById('id-field');
        this.barcodeValue = document.getElementById('barcode-value');
        this.idValue = document.getElementById('id-value');

        // Buttons
        this.btnStart = document.getElementById('btn-start');
        this.btnConfirm = document.getElementById('btn-confirm');
        this.btnRetry = document.getElementById('btn-retry');
        this.btnManual = document.getElementById('btn-manual');
        this.btnStop = document.getElementById('btn-stop');
        this.btnExport = document.getElementById('btn-export');
        this.btnClear = document.getElementById('btn-clear');

        // Table
        this.emptyState = document.getElementById('empty-state');
        this.tableWrapper = document.getElementById('table-wrapper');
        this.recordsBody = document.getElementById('records-body');
        this.totalCount = document.getElementById('total-count');

        // Modal
        this.manualModal = document.getElementById('manual-modal');
        this.manualBarcodeInput = document.getElementById('manual-barcode');
        this.manualIdInput = document.getElementById('manual-id');
        this.manualBarcodeGroup = document.getElementById('manual-barcode-group');
        this.manualIdGroup = document.getElementById('manual-id-group');

        // Toast
        this.toastContainer = document.getElementById('toast-container');

        // OCR Status
        this.ocrStatus = document.getElementById('ocr-status');
        this.ocrStatusText = document.getElementById('ocr-status-text');
        this.ocrProgress = document.getElementById('ocr-progress');
    }

    bindEvents() {
        // Manual input: Enter key
        this.manualIdInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.submitManualInput();
        });
        this.manualBarcodeInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (this.manualIdInput.closest('.form-group').classList.contains('hidden')) {
                    this.submitManualInput();
                } else {
                    this.manualIdInput.focus();
                }
            }
        });

        // Only allow digits in ID input
        this.manualIdInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/\D/g, '').slice(0, 8);
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!this.manualModal.classList.contains('hidden')) {
                    this.hideManualInput();
                }
            }
        });
    }

    // ---- Barcode Detector ----
    async initBarcodeDetector() {
        if ('BarcodeDetector' in window) {
            try {
                const formats = await BarcodeDetector.getSupportedFormats();
                this.barcodeDetector = new BarcodeDetector({ formats });
                this.barcodeSupported = true;
                console.log('BarcodeDetector initialized. Formats:', formats);
            } catch (e) {
                console.warn('BarcodeDetector init failed:', e);
                this.barcodeSupported = false;
            }
        } else {
            console.warn('BarcodeDetector not supported in this browser');
            this.barcodeSupported = false;
        }
    }

    // ---- OCR (Tesseract.js) ----
    async initOCR() {
        if (typeof Tesseract === 'undefined') {
            console.error('Tesseract.js not loaded');
            return;
        }

        this.showOCRStatus('جاري تحميل محرك قراءة الأرقام...');

        try {
            this.ocrWorker = await Tesseract.createWorker({
                logger: (m) => {
                    if (m.status === 'loading tesseract core') {
                        this.updateOCRProgress(20);
                    } else if (m.status === 'initializing tesseract') {
                        this.updateOCRProgress(40);
                        this.showOCRStatus('جاري تهيئة المحرك...');
                    } else if (m.status === 'loading language traineddata') {
                        this.updateOCRProgress(60);
                        this.showOCRStatus('جاري تحميل بيانات اللغة...');
                    } else if (m.status === 'initializing api') {
                        this.updateOCRProgress(80);
                        this.showOCRStatus('جاري تهيئة API...');
                    } else if (m.status === 'recognizing text' && m.progress) {
                        // During recognition
                    }
                },
            });

            await this.ocrWorker.loadLanguage('eng');
            await this.ocrWorker.initialize('eng');
            await this.ocrWorker.setParameters({
                tessedit_char_whitelist: '0123456789',
                tessedit_pageseg_mode: '7', // Treat as single text line
            });

            this.ocrReady = true;
            this.updateOCRProgress(100);
            this.showOCRStatus('محرك القراءة جاهز ✓');
            setTimeout(() => this.hideOCRStatus(), 2000);
            console.log('Tesseract.js OCR worker initialized');
        } catch (e) {
            console.error('OCR init failed:', e);
            this.showOCRStatus('فشل تحميل محرك القراءة');
            setTimeout(() => this.hideOCRStatus(), 3000);
        }
    }

    showOCRStatus(text) {
        this.ocrStatus.classList.remove('hidden');
        this.ocrStatusText.textContent = text;
    }

    hideOCRStatus() {
        this.ocrStatus.classList.add('hidden');
    }

    updateOCRProgress(percent) {
        this.ocrProgress.style.width = percent + '%';
    }

    // ---- Camera ----
    async startCamera() {
        try {
            const constraints = {
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: false,
            };

            this.videoStream = await navigator.mediaDevices.getUserMedia(constraints);
            this.video.srcObject = this.videoStream;
            await this.video.play();

            this.cameraPlaceholder.classList.add('hidden');
            return true;
        } catch (e) {
            console.error('Camera error:', e);
            if (e.name === 'NotAllowedError') {
                this.showToast('تم رفض إذن الكاميرا. الرجاء السماح بالوصول للكاميرا.', 'error');
            } else if (e.name === 'NotFoundError') {
                this.showToast('لم يتم العثور على كاميرا. الرجاء توصيل كاميرا.', 'error');
            } else {
                this.showToast('خطأ في تشغيل الكاميرا: ' + e.message, 'error');
            }
            return false;
        }
    }

    stopCamera() {
        if (this.videoStream) {
            this.videoStream.getTracks().forEach((t) => t.stop());
            this.videoStream = null;
        }
        this.video.srcObject = null;
        this.cameraPlaceholder.classList.remove('hidden');
    }

    captureFrame() {
        if (!this.video.videoWidth || !this.video.videoHeight) return null;
        this.canvas.width = this.video.videoWidth;
        this.canvas.height = this.video.videoHeight;
        this.ctx.drawImage(this.video, 0, 0);
        return this.canvas;
    }

    // ---- Scanning Control ----
    async startScanning() {
        const cameraStarted = await this.startCamera();
        if (!cameraStarted) return;

        // Reset current scan
        this.currentBarcode = null;
        this.currentId = null;

        // Start barcode scanning
        this.switchToBarcodeScan();
    }

    stopScanning() {
        this.clearScanTimers();
        this.stopCamera();
        this.state = AppState.IDLE;
        this.currentBarcode = null;
        this.currentId = null;
        this.scanOverlay.classList.add('hidden');
        this.currentScanEl.classList.add('hidden');
        this.updateStateBar();
        this.updateButtons();
    }

    clearScanTimers() {
        if (this.barcodeScanTimer) {
            clearInterval(this.barcodeScanTimer);
            this.barcodeScanTimer = null;
        }
        if (this.ocrScanTimer) {
            clearInterval(this.ocrScanTimer);
            this.ocrScanTimer = null;
        }
    }

    // ---- Barcode Scanning ----
    switchToBarcodeScan() {
        this.clearScanTimers();
        this.state = AppState.SCANNING_BARCODE;
        this.currentBarcode = null;
        this.currentId = null;

        // Update UI
        this.scanOverlay.classList.remove('hidden');
        this.scanOverlay.className = 'scan-overlay mode-barcode';
        this.currentScanEl.classList.remove('hidden');
        this.barcodeValue.textContent = '...جاري البحث';
        this.idValue.textContent = '---';
        this.barcodeField.className = 'scan-field active';
        this.idField.className = 'scan-field';
        this.updateStateBar();
        this.updateButtons();

        if (!this.barcodeSupported) {
            this.showToast('المتصفح لا يدعم مسح الباركود تلقائياً. استخدم الإدخال اليدوي.', 'warning');
            return;
        }

        // Start scanning loop
        this.barcodeScanTimer = setInterval(() => this.scanForBarcode(), 250);
    }

    async scanForBarcode() {
        if (!this.barcodeDetector || this.state !== AppState.SCANNING_BARCODE) return;

        try {
            const frame = this.captureFrame();
            if (!frame) return;

            const barcodes = await this.barcodeDetector.detect(frame);
            if (barcodes.length > 0) {
                const value = barcodes[0].rawValue;
                if (value && value.trim().length > 0) {
                    this.onBarcodeDetected(value.trim());
                }
            }
        } catch (e) {
            // Silent fail - continuous scanning
        }
    }

    onBarcodeDetected(barcode) {
        this.clearScanTimers();
        this.currentBarcode = barcode;

        // Update UI
        this.barcodeValue.textContent = barcode;
        this.barcodeField.className = 'scan-field found';

        // Feedback
        this.playBeep(800, 100);
        this.flashSuccess();
        this.showToast('تم مسح الباركود: ' + barcode, 'success');

        // Auto-advance to OCR after a short delay
        setTimeout(() => this.switchToIDScan(), 800);
    }

    // ---- OCR Scanning ----
    switchToIDScan() {
        this.clearScanTimers();
        this.state = AppState.SCANNING_ID;
        this.currentId = null;

        // Update UI
        this.scanOverlay.className = 'scan-overlay mode-ocr';
        this.idValue.textContent = '...جاري القراءة';
        this.idField.className = 'scan-field active-ocr';
        this.updateStateBar();
        this.updateButtons();

        if (!this.ocrReady) {
            this.showToast('محرك القراءة لم يتم تحميله بعد. استخدم الإدخال اليدوي.', 'warning');
            return;
        }

        // Start OCR scanning loop (every 2 seconds due to processing time)
        this.ocrScanTimer = setInterval(() => this.scanForID(), 2000);
        // Also run immediately
        this.scanForID();
    }

    async scanForID() {
        if (this.isOCRBusy || this.state !== AppState.SCANNING_ID || !this.ocrReady) return;

        this.isOCRBusy = true;

        try {
            const frame = this.captureFrame();
            if (!frame) {
                this.isOCRBusy = false;
                return;
            }

            // Preprocess the image for better OCR
            this.preprocessForOCR();

            // Run OCR
            const { data: { text } } = await this.ocrWorker.recognize(this.canvas);
            const idNumber = this.extractIDNumber(text);

            if (idNumber) {
                this.onIDDetected(idNumber);
            }
        } catch (e) {
            console.error('OCR scan error:', e);
        }

        this.isOCRBusy = false;
    }

    preprocessForOCR() {
        const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
            // Convert to grayscale
            const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

            // Increase contrast
            const contrast = 1.5;
            const adjusted = ((gray / 255 - 0.5) * contrast + 0.5) * 255;

            // Apply threshold (binarize)
            const binary = adjusted > 130 ? 255 : 0;

            data[i] = binary;
            data[i + 1] = binary;
            data[i + 2] = binary;
        }

        this.ctx.putImageData(imageData, 0, 0);
    }

    extractIDNumber(text) {
        if (!text) return null;

        // Remove all whitespace and non-digit characters
        const cleaned = text.replace(/[^0-9]/g, '');

        // Look for exactly 8 consecutive digits
        const match = cleaned.match(/\d{8}/);
        return match ? match[0] : null;
    }

    onIDDetected(idNumber) {
        this.clearScanTimers();
        this.currentId = idNumber;
        this.state = AppState.CONFIRMING;

        // Update UI
        this.idValue.textContent = idNumber;
        this.idField.className = 'scan-field found';
        this.scanOverlay.classList.add('hidden');
        this.updateStateBar();
        this.updateButtons();

        // Feedback
        this.playBeep(1200, 150);
        this.flashSuccess();
        this.showToast('تم قراءة الرقم التعريفي: ' + idNumber, 'success');
    }

    // ---- Record Management ----
    confirmRecord() {
        if (!this.currentBarcode || !this.currentId) {
            this.showToast('البيانات غير مكتملة', 'error');
            return;
        }

        const record = {
            barcode: this.currentBarcode,
            idNumber: this.currentId,
            timestamp: new Date().toLocaleString('ar-EG', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            }),
        };

        this.records.push(record);
        this.saveToStorage();
        this.updateTable();

        // Feedback
        this.playBeep(1500, 200);
        this.showToast(`تم حفظ السجل #${this.records.length} بنجاح`, 'success');

        // Auto-advance to next barcode scan
        setTimeout(() => this.switchToBarcodeScan(), 600);
    }

    deleteRecord(index) {
        if (index < 0 || index >= this.records.length) return;
        this.records.splice(index, 1);
        this.saveToStorage();
        this.updateTable();
        this.showToast('تم حذف السجل', 'info');
    }

    clearAllRecords() {
        if (this.records.length === 0) return;
        if (!confirm('هل أنت متأكد من حذف جميع السجلات؟')) return;
        this.records = [];
        this.saveToStorage();
        this.updateTable();
        this.showToast('تم مسح جميع السجلات', 'info');
    }

    retryCurrentStep() {
        if (this.state === AppState.CONFIRMING || this.state === AppState.SCANNING_ID) {
            // If we already have a barcode but ID failed, retry OCR
            if (this.currentBarcode) {
                this.currentId = null;
                this.switchToIDScan();
            } else {
                this.switchToBarcodeScan();
            }
        } else {
            this.switchToBarcodeScan();
        }
    }

    // ---- Storage ----
    saveToStorage() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.records));
        } catch (e) {
            console.warn('Failed to save to localStorage:', e);
        }
    }

    loadFromStorage() {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY);
            if (data) {
                this.records = JSON.parse(data);
            }
        } catch (e) {
            console.warn('Failed to load from localStorage:', e);
            this.records = [];
        }
    }

    // ---- Excel Export ----
    exportToExcel() {
        if (this.records.length === 0) {
            this.showToast('لا توجد بيانات للتصدير', 'warning');
            return;
        }

        if (typeof XLSX === 'undefined') {
            this.showToast('مكتبة Excel غير محملة. الرجاء إعادة تحميل الصفحة.', 'error');
            return;
        }

        try {
            // Prepare data
            const data = this.records.map((r, i) => ({
                '#': i + 1,
                'باركود الملف': r.barcode,
                'الرقم التعريفي': r.idNumber,
                'التاريخ والوقت': r.timestamp,
            }));

            // Create workbook
            const ws = XLSX.utils.json_to_sheet(data);

            // Set column widths
            ws['!cols'] = [
                { wch: 5 },   // #
                { wch: 25 },  // Barcode
                { wch: 15 },  // ID Number
                { wch: 22 },  // Timestamp
            ];

            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'البيانات');

            // Generate filename with date
            const dateStr = new Date().toISOString().slice(0, 10);
            const filename = `scan_data_${dateStr}.xlsx`;

            // Download
            XLSX.writeFile(wb, filename);

            this.showToast(`تم تصدير ${this.records.length} سجل إلى ${filename}`, 'success');
        } catch (e) {
            console.error('Export error:', e);
            this.showToast('خطأ في تصدير البيانات: ' + e.message, 'error');
        }
    }

    // ---- Manual Input ----
    showManualInput() {
        // Determine which fields to show
        const needBarcode = !this.currentBarcode || this.state === AppState.IDLE;
        const needId = true;

        this.manualBarcodeGroup.classList.toggle('hidden', !needBarcode);
        this.manualIdGroup.classList.remove('hidden');

        // Pre-fill if available
        this.manualBarcodeInput.value = this.currentBarcode || '';
        this.manualIdInput.value = this.currentId || '';

        this.manualModal.classList.remove('hidden');

        // Focus appropriate input
        setTimeout(() => {
            if (needBarcode) {
                this.manualBarcodeInput.focus();
            } else {
                this.manualIdInput.focus();
            }
        }, 100);
    }

    hideManualInput() {
        this.manualModal.classList.add('hidden');
    }

    handleModalOverlayClick(event) {
        if (event.target === this.manualModal) {
            this.hideManualInput();
        }
    }

    submitManualInput() {
        const barcodeGroupVisible = !this.manualBarcodeGroup.classList.contains('hidden');
        const barcode = barcodeGroupVisible
            ? this.manualBarcodeInput.value.trim()
            : this.currentBarcode;
        const idNumber = this.manualIdInput.value.trim();

        // Validate
        if (barcodeGroupVisible && !barcode) {
            this.showToast('الرجاء إدخال الباركود', 'error');
            this.manualBarcodeInput.focus();
            return;
        }

        if (!idNumber) {
            this.showToast('الرجاء إدخال الرقم التعريفي', 'error');
            this.manualIdInput.focus();
            return;
        }

        if (!/^\d{8}$/.test(idNumber)) {
            this.showToast('الرقم التعريفي يجب أن يكون 8 أرقام', 'error');
            this.manualIdInput.focus();
            return;
        }

        // Save
        this.currentBarcode = barcode;
        this.currentId = idNumber;

        // Update display
        this.barcodeValue.textContent = barcode;
        this.idValue.textContent = idNumber;
        this.barcodeField.className = 'scan-field found';
        this.idField.className = 'scan-field found';
        this.currentScanEl.classList.remove('hidden');

        this.hideManualInput();

        // Add record
        const record = {
            barcode: this.currentBarcode,
            idNumber: this.currentId,
            timestamp: new Date().toLocaleString('ar-EG', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            }),
        };

        this.records.push(record);
        this.saveToStorage();
        this.updateTable();

        this.playBeep(1500, 200);
        this.showToast(`تم حفظ السجل #${this.records.length} بنجاح`, 'success');

        // If camera is active, continue scanning
        if (this.videoStream) {
            setTimeout(() => this.switchToBarcodeScan(), 600);
        } else {
            this.currentBarcode = null;
            this.currentId = null;
        }
    }

    // ---- UI Updates ----
    updateStateBar() {
        let stateClass = '';
        let stateText = '';
        let modeText = '';

        switch (this.state) {
            case AppState.IDLE:
                stateClass = '';
                stateText = 'في انتظار البدء';
                modeText = '';
                break;
            case AppState.SCANNING_BARCODE:
                stateClass = 'barcode';
                stateText = 'جاري مسح الباركود...';
                modeText = 'BARCODE';
                break;
            case AppState.SCANNING_ID:
                stateClass = 'ocr';
                stateText = 'جاري قراءة الرقم التعريفي...';
                modeText = 'OCR';
                break;
            case AppState.CONFIRMING:
                stateClass = 'confirming';
                stateText = 'في انتظار التأكيد';
                modeText = 'CONFIRM';
                break;
        }

        this.stateIndicator.className = 'state-indicator ' + stateClass;
        this.stateText.textContent = stateText;
        this.stateMode.textContent = modeText;
    }

    updateButtons() {
        const isIdle = this.state === AppState.IDLE;
        const isScanning = this.state === AppState.SCANNING_BARCODE || this.state === AppState.SCANNING_ID;
        const isConfirming = this.state === AppState.CONFIRMING;

        // Start button
        this.btnStart.classList.toggle('hidden', !isIdle);
        if (isIdle) {
            this.btnStart.classList.add('btn-glow');
        } else {
            this.btnStart.classList.remove('btn-glow');
        }

        // Confirm button
        this.btnConfirm.classList.toggle('hidden', !isConfirming);

        // Retry button
        this.btnRetry.classList.toggle('hidden', !isScanning && !isConfirming);

        // Manual button
        this.btnManual.classList.toggle('hidden', isIdle);

        // Stop button
        this.btnStop.classList.toggle('hidden', isIdle);

        // Export button
        this.btnExport.disabled = this.records.length === 0;
    }

    updateTable() {
        const hasRecords = this.records.length > 0;

        this.emptyState.classList.toggle('hidden', hasRecords);
        this.tableWrapper.classList.toggle('hidden', !hasRecords);
        this.totalCount.textContent = this.records.length;
        this.btnExport.disabled = !hasRecords;

        // Rebuild table body
        this.recordsBody.innerHTML = '';

        this.records.forEach((record, index) => {
            const row = document.createElement('tr');
            row.className = index === this.records.length - 1 ? 'new-row' : '';
            row.innerHTML = `
                <td>${index + 1}</td>
                <td class="cell-barcode">${this.escapeHTML(record.barcode)}</td>
                <td class="cell-id">${this.escapeHTML(record.idNumber)}</td>
                <td class="cell-time">${this.escapeHTML(record.timestamp)}</td>
                <td>
                    <button class="btn-delete-row" onclick="app.deleteRecord(${index})" title="حذف">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </td>
            `;
            this.recordsBody.appendChild(row);
        });

        // Scroll to bottom
        if (hasRecords) {
            const tableContainer = this.tableWrapper;
            tableContainer.scrollTop = tableContainer.scrollHeight;
        }
    }

    // ---- Feedback ----
    flashSuccess() {
        this.successFlash.classList.remove('active');
        // Force reflow
        void this.successFlash.offsetWidth;
        this.successFlash.classList.add('active');
        setTimeout(() => this.successFlash.classList.remove('active'), 600);
    }

    playBeep(frequency = 1000, duration = 150) {
        try {
            if (!this.audioCtx) {
                this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }

            const oscillator = this.audioCtx.createOscillator();
            const gainNode = this.audioCtx.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(this.audioCtx.destination);

            oscillator.frequency.value = frequency;
            oscillator.type = 'sine';
            gainNode.gain.value = 0.25;

            // Fade out
            gainNode.gain.setValueAtTime(0.25, this.audioCtx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + duration / 1000);

            oscillator.start(this.audioCtx.currentTime);
            oscillator.stop(this.audioCtx.currentTime + duration / 1000);
        } catch (e) {
            // Silent fail for audio
        }
    }

    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠',
            info: 'ℹ',
        };

        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || icons.info}</span>
            <span class="toast-msg">${this.escapeHTML(message)}</span>
        `;

        this.toastContainer.appendChild(toast);

        // Auto remove
        setTimeout(() => {
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ---- Utilities ----
    escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

// ---- Initialize App ----
const app = new ScannerApp();

document.addEventListener('DOMContentLoaded', () => {
    app.init();
});
