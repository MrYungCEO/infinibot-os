/**
 * Shell Type Detector
 * Detects Windows shell type for proper command chaining
 */

import type { WindowsShellType } from '../types.js';

/**
 * Detect Windows shell type from shell path
 * PowerShell 5.1 uses ';' for command chaining
 * PowerShell 7+, CMD, and bash use '&&'
 */
export function detectWindowsShellType(shellPath: string): WindowsShellType {
    const lowerPath = shellPath.toLowerCase();

    // PowerShell 5.1 (Windows PowerShell)
    if (lowerPath.includes('windowspowershell') ||
        (lowerPath.includes('powershell.exe') && !lowerPath.includes('pwsh'))) {
        return 'powershell';
    }

    // Everything else (PowerShell 7+, CMD, bash, etc.) uses '&&'
    return 'cmd';
}

/**
 * Get command chaining operator for the shell type
 */
export function getCommandChainOperator(shellType: WindowsShellType): string {
    return shellType === 'powershell' ? ';' : '&&';
}
