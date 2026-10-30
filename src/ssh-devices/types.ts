/**
 * SSH Device Management Types
 * Network SSH devices that can be configured and connected to
 */

export interface SSHDevice {
  id: string;
  name: string;
  ip: string;
  port: number;
  username: string;
  password?: string; // Encrypted when stored
  privateKey?: string; // Path to SSH key file
  description?: string;
  tags?: string[];
  
  // Connection metadata
  lastConnected?: number;
  lastSeen?: number;
  isOnline?: boolean;
  
  // Discovery metadata
  discoveredAt?: number;
  hostname?: string;
  osType?: string;
  
  createdAt: number;
  updatedAt: number;
}

export interface SSHDeviceScanResult {
  ip: string;
  port: number;
  hostname?: string;
  isSSH: boolean;
  responseTime?: number;
}

export interface SSHDeviceConnectionTest {
  success: boolean;
  message: string;
  latencyMs?: number;
  serverVersion?: string;
}

export type SSHDeviceStatus = 'online' | 'offline' | 'unknown';

export interface SSHDeviceStore {
  devices: Record<string, SSHDevice>;
  activeDeviceId?: string;
}
