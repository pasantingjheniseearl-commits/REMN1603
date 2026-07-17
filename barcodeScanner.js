/**
 * BARCODE SCANNER - Complete Standalone Implementation
 * Handles 14→8 digit extraction + Find popup blocking
 * 
 * This module:
 * 1. Provides barcode extraction functions
 * 2. Sets up aggressive Find popup blocking on the scanner view
 * 3. Works alongside existing app.js implementations
 * 
 * Load order: barcodeScanner.js → parseScannedInput.js → app.js
 */

(function() {
  'use strict';

  console.log('========================================');
  console.log('🎯 Barcode Scanner Module Initializing');
  console.log('========================================');

  // ============================================================================
  // PART 1: BARCODE EXTRACTION (Redundant with parseScannedInput.js, but safe)
  // ============================================================================

  /**
   * Extract 8-digit SKU from 14-digit barcode
   * Format: 02050-XXXXXXXX-C
   * Extracts: XXXXXXXX (middle 8 digits)
   */
  function extractSKUFromBarcode(input) {
    if (!input || typeof input !== 'string') {
      console.warn('[extractSKUFromBarcode] Invalid input:', input);
      return { mode: 'manual', sku: '', raw: input };
    }

    const trimmed = input.trim();
    
    // Remove ALL non-digit characters (dashes, spaces, dots, etc)
    const digitsOnly = trimmed.replace(/\D/g, '');
    
    console.log(`[extractSKUFromBarcode]
      Input: "${trimmed}"
      Digits: "${digitsOnly}" (length: ${digitsOnly.length})`);
    
    // Check if it matches 14-digit barcode pattern: 02050 + 8 digits + 1 check digit
    const barcodeRegex = /^02050\d{9}$/;
    
    if (barcodeRegex.test(digitsOnly)) {
      // Valid barcode: extract positions 5-12 (the 8-digit SKU)
      const sku = digitsOnly.substring(5, 13).toUpperCase();
      console.log(`[extractSKUFromBarcode] ✓ BARCODE detected! Extracted SKU: ${sku}`);
      
      return {
        mode: 'barcode',
        sku: sku,
        raw: trimmed,
        fullBarcode: digitsOnly,
        timestamp: new Date().toISOString()
      };
    }
    
    // Not a barcode - treat as manual entry
    console.log(`[extractSKUFromBarcode] Manual SKU entry: "${trimmed}"`);
    return {
      mode: 'manual',
      sku: trimmed.toUpperCase(),
      raw: trimmed,
      timestamp: new Date().toISOString()
    };
  }

  // Expose globally
  window.extractSKUFromBarcode = extractSKUFromBarcode;

  // ============================================================================
  // PART 2: AGGRESSIVE FIND POPUP BLOCKER
  // ============================================================================

  /**
   * Multi-layered Find popup blocker that works across all browsers
   */
  function setupFindBlocker() {
    console.log('[setupFindBlocker] Setting up Find popup blocker');
    
    // Wait for DOM to be ready if needed
    function enableBlocker() {
      const scanInput = document.getElementById('mock-scan-input');
      const barcodeView = document.getElementById('view-barcode');
      
      if (!scanInput) {
        console.warn('[setupFindBlocker] Scanner input element not found yet');
        return false;
      }
      
      if (!barcodeView) {
        console.warn('[setupFindBlocker] Barcode view element not found yet');
        return false;
      }

      // ─── Level 1: Block on scanner input focus ───
      // When user focuses on the scanner input, block Find immediately
      scanInput.addEventListener('focus', function() {
        console.log('[FindBlocker L1] Scanner input focused - Find will be blocked');
      });

      scanInput.addEventListener('keydown', function(event) {
        const isFind = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f';
        
        if (isFind) {
          console.log('[FindBlocker L1] ✓ Ctrl/Cmd+F intercepted on input focus');
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          
          // Show user feedback
          if (window.showToast) {
            window.showToast('Find is disabled during barcode scanning', 'warning');
          } else {
            console.warn('showToast not available, using alert instead');
            alert('Find is disabled during barcode scanning');
          }
          return false;
        }
      }, true); // Capture phase for highest priority

      // ─── Level 2: Global block when barcode view is active ───
      // Even if focus is elsewhere, block Find when on barcode view
      document.addEventListener('keydown', function(event) {
        const isFind = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f';
        const isActive = barcodeView.classList.contains('active');
        
        if (isFind && isActive) {
          console.log('[FindBlocker L2] ✓ Ctrl/Cmd+F intercepted - Barcode view active');
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          
          // Show user feedback
          if (window.showToast) {
            window.showToast('Find is disabled during barcode scanning mode', 'warning');
          }
          return false;
        }
      }, true); // Capture phase for early interception

      // ─── Level 3: Block using window keydown listener ───
      // Catch any keydown that escapes the others
      window.addEventListener('keydown', function(event) {
        const isFind = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f';
        const isActive = barcodeView.classList.contains('active');
        
        if (isFind && isActive) {
          console.log('[FindBlocker L3] ✓ Ctrl/Cmd+F intercepted - Window level');
          event.preventDefault();
          return false;
        }
      }, true); // Capture phase

      console.log('[setupFindBlocker] ✓ Find blocker ACTIVATED (3 layers)');
      return true;
    }

    // Try to enable immediately
    if (!enableBlocker()) {
      // If DOM isn't ready, wait for DOMContentLoaded
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
          if (enableBlocker()) {
            console.log('[setupFindBlocker] ✓ Enabled after DOMContentLoaded');
          }
        });
      }
    }
  }

  // ============================================================================
  // PART 3: INITIALIZATION
  // ============================================================================

  function initialize() {
    console.log('[initialize] Starting barcode scanner module');
    
    // Set up Find blocker early
    setupFindBlocker();
    
    // Also set up when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        console.log('[initialize] ✓ Module initialized on DOMContentLoaded');
      });
    } else {
      console.log('[initialize] ✓ Module initialized immediately (DOM ready)');
    }
    
    // Expose test functions
    window.testBarcode = function(input) {
      console.group('🧪 Barcode Test');
      const result = extractSKUFromBarcode(input);
      console.log('Input:', input);
      console.log('Result:', result);
      console.groupEnd();
      return result;
    };
    
    window.testFindBlocker = function() {
      console.group('🧪 Find Blocker Test');
      console.log('Press Ctrl+F or Cmd+F on the Barcode Scanner view');
      console.log('If Find popup does NOT appear, the blocker is working');
      console.groupEnd();
    };
    
    console.log('[initialize] ✓ Test functions available:');
    console.log('  - window.testBarcode(input)');
    console.log('  - window.testFindBlocker()');
  }

  // Start initialization
  initialize();

  console.log('========================================');
  console.log('✅ Barcode Scanner Module Ready');
  console.log('========================================');
  console.log('Export Functions:');
  console.log('  - window.extractSKUFromBarcode(input)');
  console.log('  - window.testBarcode(input) [TEST]');
  console.log('  - window.testFindBlocker() [TEST]');
  console.log('========================================');

})();
