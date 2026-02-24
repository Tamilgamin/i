/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback, ChangeEvent } from 'react';
import mqtt from 'mqtt';
import { 
  Thermometer, 
  Settings as SettingsIcon, 
  Bell, 
  BellOff, 
  Wifi, 
  WifiOff, 
  Volume2, 
  Play, 
  Clock,
  ChevronLeft,
  AlertCircle,
  CheckCircle2,
  Activity
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// MQTT Configuration
const MQTT_CONFIG = {
  host: '57f9938c484c4f0f9ad4b79b70ae3bf7.s1.eu.hivemq.cloud',
  port: 8884,
  path: '/mqtt',
  protocol: 'wss' as const,
  username: 'qqqqq',
  password: 'Agash2008',
};

const TOPICS = {
  temp: 'incubator/temp',
  status: 'incubator/status',
};

// Types
type Status = 'LOW' | 'NORMAL' | 'HIGH' | 'DISCONNECTED';

interface AppSettings {
  alarmEnabled: boolean;
  alarmDuration: number; // in seconds
  alarmDurationUnit: 'seconds' | 'minutes';
  customSoundUrl: string | null;
  lowTempThreshold: number;
  highTempThreshold: number;
}

export default function App() {
  // State
  const [temp, setTemp] = useState<number | null>(null);
  const [prevTemp, setPrevTemp] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>('DISCONNECTED');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [activeTab, setActiveTab] = useState<'home' | 'settings'>('home');
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('incubator_settings');
    const defaults: AppSettings = {
      alarmEnabled: true,
      alarmDuration: 30,
      alarmDurationUnit: 'seconds',
      customSoundUrl: null,
      lowTempThreshold: 25,
      highTempThreshold: 65,
    };
    if (saved) {
      try {
        return { ...defaults, ...JSON.parse(saved), customSoundUrl: null }; // Don't persist blob URLs
      } catch (e) {
        return defaults;
      }
    }
    return defaults;
  });
  const [isAlarmActive, setIsAlarmActive] = useState(false);

  // Persistence
  useEffect(() => {
    const toSave = { ...settings, customSoundUrl: null };
    localStorage.setItem('incubator_settings', JSON.stringify(toSave));
  }, [settings]);
  
  // Refs
  const mqttClient = useRef<mqtt.MqttClient | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const alarmTimerRef = useRef<NodeJS.Timeout | null>(null);

  // MQTT Connection Logic
  useEffect(() => {
    const client = mqtt.connect(`wss://${MQTT_CONFIG.host}:${MQTT_CONFIG.port}/mqtt`, {
      username: MQTT_CONFIG.username,
      password: MQTT_CONFIG.password,
      clientId: `incubator_${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      connectTimeout: 30000, // Increased to 30 seconds
      reconnectPeriod: 5000,
      keepalive: 60,
      reschedulePings: true,
    });

    client.on('connect', () => {
      console.log('Connected to MQTT Broker');
      setIsConnected(true);
      setIsReconnecting(false);
      setErrorMsg(null);
      
      // Ensure we are still connected before subscribing
      if (client.connected) {
        client.subscribe([TOPICS.temp, TOPICS.status], (err) => {
          if (err) {
            // Suppress error if it's just a disconnect during cleanup/reconnect
            if (err.message !== 'client disconnecting') {
              console.error('Subscription error:', err);
              setErrorMsg(`Subscription failed: ${err.message}`);
            }
          } else {
            console.log('Successfully subscribed to topics');
          }
        });
      }
    });

    client.on('error', (err) => {
      // Only log and show error if it's not a standard disconnect
      if (err.message !== 'client disconnecting') {
        console.error('MQTT Error:', err);
        setErrorMsg(err.message);
      }
      setIsConnected(false);
    });

    client.on('reconnect', () => {
      console.log('Attempting to reconnect...');
      setIsReconnecting(true);
      setIsConnected(false);
      setErrorMsg('Reconnecting...');
    });

    client.on('offline', () => {
      setIsConnected(false);
      console.log('Client went offline');
    });

    client.on('message', (topic, message) => {
      const payload = message.toString();
      if (topic === TOPICS.temp) {
        const newTemp = parseFloat(payload);
        setTemp(current => {
          setPrevTemp(current);
          return newTemp;
        });
        
        // Derive status locally based on thresholds
        setSettings(s => {
          if (newTemp < s.lowTempThreshold) setStatus('LOW');
          else if (newTemp > s.highTempThreshold) setStatus('HIGH');
          else setStatus('NORMAL');
          return s;
        });
      }
    });

    client.on('close', () => {
      setIsConnected(false);
      setStatus('DISCONNECTED');
    });

    mqttClient.current = client;

    return () => {
      client.end();
    };
  }, []);

  // Alarm Logic
  const stopAlarm = useCallback(() => {
    setIsAlarmActive(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (alarmTimerRef.current) {
      clearTimeout(alarmTimerRef.current);
    }
  }, []);

  const triggerAlarm = useCallback(() => {
    if (!settings.alarmEnabled || isAlarmActive) return;

    setIsAlarmActive(true);
    
    // Play sound
    if (audioRef.current) {
      audioRef.current.play().catch(e => console.error("Audio playback failed", e));
    }

    // Push Notification (Web simulation)
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Incubator Alert!", {
        body: `Temperature is ${temp}°C (${status}). Check the incubator immediately.`,
        icon: "/favicon.ico"
      });
    }

    // Auto stop after duration
    const durationMs = settings.alarmDurationUnit === 'minutes' 
      ? settings.alarmDuration * 60 * 1000 
      : settings.alarmDuration * 1000;
    
    alarmTimerRef.current = setTimeout(stopAlarm, durationMs);
  }, [settings, isAlarmActive, temp, status, stopAlarm]);

  // Monitor Temp for Alarms
  useEffect(() => {
    if (temp !== null) {
      if (temp < settings.lowTempThreshold || temp > settings.highTempThreshold) {
        triggerAlarm();
      } else if (isAlarmActive) {
        // Optional: stop alarm if temp returns to normal? 
        // The prompt says "Alarm stops automatically after selected duration", 
        // but usually you'd want it to stop if the condition clears too.
        // For now, let's stick to the duration rule.
      }
    }
  }, [temp, triggerAlarm, isAlarmActive, settings.lowTempThreshold, settings.highTempThreshold]);

  // Request Notification Permission
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // UI Helpers
  const getStatusColor = (s: Status) => {
    switch (s) {
      case 'LOW': return 'text-blue-500';
      case 'NORMAL': return 'text-emerald-500';
      case 'HIGH': return 'text-red-500';
      default: return 'text-zinc-400';
    }
  };

  const getStatusBg = (s: Status) => {
    switch (s) {
      case 'LOW': return 'bg-blue-500/10';
      case 'NORMAL': return 'bg-emerald-500/10';
      case 'HIGH': return 'bg-red-500/10';
      default: return 'bg-zinc-500/10';
    }
  };

  const handleSoundUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setSettings(prev => ({ ...prev, customSoundUrl: url }));
    }
  };

  const testAlarm = () => {
    if (audioRef.current) {
      audioRef.current.play().catch(e => console.error("Test playback failed", e));
      setTimeout(() => {
        audioRef.current?.pause();
        if (audioRef.current) audioRef.current.currentTime = 0;
      }, 3000);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      {/* Hidden Audio Element */}
      <audio 
        ref={audioRef} 
        src={settings.customSoundUrl || 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3'} 
        loop 
      />

      {/* Main Container */}
      <div className="max-w-md mx-auto min-h-screen flex flex-col relative overflow-hidden">
        
        {/* Header */}
        <header className="p-6 flex justify-between items-center border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-20">
          <div className="flex items-center space-x-3">
            <div className={cn(
              "p-2 rounded-xl transition-colors duration-500", 
              isConnected ? "bg-emerald-500/10" : isReconnecting ? "bg-amber-500/10" : "bg-red-500/10"
            )}>
              {isConnected ? (
                <Wifi className="w-5 h-5 text-emerald-500" />
              ) : isReconnecting ? (
                <motion.div
                  animate={{ opacity: [1, 0.5, 1] }}
                  transition={{ repeat: Infinity, duration: 1 }}
                >
                  <Wifi className="w-5 h-5 text-amber-500" />
                </motion.div>
              ) : (
                <WifiOff className="w-5 h-5 text-red-500" />
              )}
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">Incubator</h1>
              <p className={cn(
                "text-[10px] font-mono uppercase tracking-widest transition-colors duration-500", 
                isConnected ? "text-emerald-500" : isReconnecting ? "text-amber-500" : "text-red-500"
              )}>
                {isConnected ? 'Connected' : isReconnecting ? 'Reconnecting...' : errorMsg || 'Disconnected'}
              </p>
            </div>
          </div>
          
          <button 
            onClick={() => setActiveTab(activeTab === 'home' ? 'settings' : 'home')}
            className="p-2 rounded-xl hover:bg-zinc-800 transition-colors"
          >
            {activeTab === 'home' ? <SettingsIcon className="w-6 h-6" /> : <ChevronLeft className="w-6 h-6" />}
          </button>
        </header>

        {/* Content */}
        <main className="flex-1 p-6 overflow-y-auto pb-24">
          <AnimatePresence mode="wait">
            {activeTab === 'home' ? (
              <motion.div 
                key="home"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-8"
              >
                {/* Temp Display */}
                <div className="relative flex flex-col items-center py-12">
                  {/* Dynamic Background Glow */}
                  <motion.div 
                    animate={{
                      scale: [1, 1.2, 1],
                      opacity: [0.05, 0.1, 0.05],
                    }}
                    transition={{
                      duration: 4,
                      repeat: Infinity,
                      ease: "easeInOut"
                    }}
                    className={cn(
                      "absolute inset-0 blur-[100px] rounded-full transition-colors duration-1000",
                      status === 'HIGH' ? "bg-red-500" : status === 'LOW' ? "bg-blue-500" : "bg-emerald-500"
                    )}
                  />
                  
                  <div className="relative flex flex-col items-center">
                    {/* Trend Indicator */}
                    <AnimatePresence mode="wait">
                      {temp !== null && prevTemp !== null && temp !== prevTemp && (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className="absolute -top-8 flex items-center space-x-1"
                        >
                          {temp > prevTemp ? (
                            <motion.div animate={{ y: [0, -4, 0] }} transition={{ repeat: Infinity }} className="text-red-400 flex items-center">
                              <span className="text-[10px] font-bold mr-1">RISING</span>
                              <Activity className="w-3 h-3 rotate-180" />
                            </motion.div>
                          ) : (
                            <motion.div animate={{ y: [0, 4, 0] }} transition={{ repeat: Infinity }} className="text-blue-400 flex items-center">
                              <span className="text-[10px] font-bold mr-1">FALLING</span>
                              <Activity className="w-3 h-3" />
                            </motion.div>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <motion.div 
                      key={temp}
                      initial={{ scale: 0.95, opacity: 0, filter: 'blur(10px)' }}
                      animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                      className="text-[120px] font-light tracking-tighter leading-none flex items-start"
                    >
                      {temp !== null ? Math.round(temp) : '--'}
                      <span className="text-4xl font-medium text-zinc-600 mt-4 ml-2">°C</span>
                    </motion.div>

                    {/* Pulse Ring on Update */}
                    <AnimatePresence>
                      <motion.div
                        key={`pulse-${temp}`}
                        initial={{ scale: 0.8, opacity: 0.5, border: '2px solid rgba(16, 185, 129, 0.5)' }}
                        animate={{ scale: 1.5, opacity: 0, border: '2px solid rgba(16, 185, 129, 0)' }}
                        className="absolute inset-0 rounded-full pointer-events-none"
                        style={{ margin: '-20px' }}
                      />
                    </AnimatePresence>
                  </div>

                  <div className={cn(
                    "mt-8 px-6 py-2 rounded-full flex items-center space-x-2 border border-white/5 transition-colors duration-500",
                    getStatusBg(status)
                  )}>
                    <motion.div
                      animate={status === 'NORMAL' ? {} : { scale: [1, 1.2, 1] }}
                      transition={{ repeat: Infinity, duration: 2 }}
                    >
                      <Activity className={cn("w-4 h-4", getStatusColor(status))} />
                    </motion.div>
                    <span className={cn("text-sm font-bold tracking-widest uppercase", getStatusColor(status))}>
                      {status}
                    </span>
                  </div>

                  {/* Threshold Indicators */}
                  <div className="mt-6 flex justify-center space-x-12 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
                    <div className="flex flex-col items-center">
                      <span className="mb-1 opacity-50">Low Limit</span>
                      <span className="text-blue-400/80">{settings.lowTempThreshold}°C</span>
                    </div>
                    <div className="flex flex-col items-center">
                      <span className="mb-1 opacity-50">High Limit</span>
                      <span className="text-red-400/80">{settings.highTempThreshold}°C</span>
                    </div>
                  </div>
                </div>

                {/* Stats Grid */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-zinc-900/50 border border-zinc-800 p-5 rounded-3xl">
                    <div className="flex items-center space-x-2 mb-3 text-zinc-500">
                      <Thermometer className="w-4 h-4" />
                      <span className="text-[10px] font-bold uppercase tracking-wider">Precision</span>
                    </div>
                    <p className="text-2xl font-mono">{temp !== null ? temp.toFixed(2) : '--'}<span className="text-xs ml-1 text-zinc-500">°C</span></p>
                  </div>
                  <div className="bg-zinc-900/50 border border-zinc-800 p-5 rounded-3xl">
                    <div className="flex items-center space-x-2 mb-3 text-zinc-500">
                      <Bell className="w-4 h-4" />
                      <span className="text-[10px] font-bold uppercase tracking-wider">Alarm</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <div className={cn("w-2 h-2 rounded-full animate-pulse", isAlarmActive ? "bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]" : "bg-zinc-700")} />
                      <p className="text-sm font-semibold">{isAlarmActive ? 'TRIGGERED' : 'STANDBY'}</p>
                    </div>
                  </div>
                </div>

                {/* Alarm Banner */}
                {isAlarmActive && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    className="bg-red-500 text-white p-4 rounded-2xl flex items-center justify-between shadow-[0_0_30px_rgba(239,68,68,0.3)]"
                  >
                    <div className="flex items-center space-x-3">
                      <AlertCircle className="w-6 h-6 animate-bounce" />
                      <div>
                        <p className="font-bold text-sm">CRITICAL TEMPERATURE</p>
                        <p className="text-[10px] opacity-80">Alarm will stop in {settings.alarmDuration} {settings.alarmDurationUnit}</p>
                      </div>
                    </div>
                    <button 
                      onClick={stopAlarm}
                      className="bg-white/20 hover:bg-white/30 px-4 py-2 rounded-xl text-xs font-bold transition-colors"
                    >
                      MUTE
                    </button>
                  </motion.div>
                )}
              </motion.div>
            ) : (
              <motion.div 
                key="settings"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-8"
              >
                <div className="space-y-6">
                  {/* Alarm Toggle */}
                  <div className="flex items-center justify-between bg-zinc-900/50 p-6 rounded-3xl border border-zinc-800">
                    <div className="flex items-center space-x-4">
                      <div className={cn("p-3 rounded-2xl", settings.alarmEnabled ? "bg-emerald-500/10" : "bg-zinc-800")}>
                        {settings.alarmEnabled ? <Bell className="w-6 h-6 text-emerald-500" /> : <BellOff className="w-6 h-6 text-zinc-500" />}
                      </div>
                      <div>
                        <p className="font-bold">Master Alarm</p>
                        <p className="text-xs text-zinc-500">Enable temperature alerts</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => setSettings(s => ({ ...s, alarmEnabled: !s.alarmEnabled }))}
                      className={cn(
                        "w-14 h-8 rounded-full relative transition-colors duration-300",
                        settings.alarmEnabled ? "bg-emerald-500" : "bg-zinc-700"
                      )}
                    >
                      <div className={cn(
                        "absolute top-1 w-6 h-6 bg-white rounded-full transition-all duration-300 shadow-sm",
                        settings.alarmEnabled ? "left-7" : "left-1"
                      )} />
                    </button>
                  </div>

                  {/* Temperature Thresholds */}
                  <div className="bg-zinc-900/50 p-6 rounded-3xl border border-zinc-800 space-y-4">
                    <div className="flex items-center space-x-3 mb-2">
                      <Thermometer className="w-5 h-5 text-zinc-400" />
                      <p className="font-bold">Temp Thresholds</p>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Low (°C)</label>
                        <input 
                          type="number" 
                          value={settings.lowTempThreshold}
                          onChange={(e) => setSettings(s => ({ ...s, lowTempThreshold: parseFloat(e.target.value) || 0 }))}
                          className="w-full bg-zinc-800 border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">High (°C)</label>
                        <input 
                          type="number" 
                          value={settings.highTempThreshold}
                          onChange={(e) => setSettings(s => ({ ...s, highTempThreshold: parseFloat(e.target.value) || 0 }))}
                          className="w-full bg-zinc-800 border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-red-500 outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Duration Setting */}
                  <div className="bg-zinc-900/50 p-6 rounded-3xl border border-zinc-800 space-y-4">
                    <div className="flex items-center space-x-3 mb-2">
                      <Clock className="w-5 h-5 text-zinc-400" />
                      <p className="font-bold">Alarm Duration</p>
                    </div>
                    <div className="flex space-x-2">
                      <input 
                        type="number" 
                        value={settings.alarmDuration}
                        onChange={(e) => setSettings(s => ({ ...s, alarmDuration: parseInt(e.target.value) || 0 }))}
                        className="flex-1 bg-zinc-800 border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
                      />
                      <select 
                        value={settings.alarmDurationUnit}
                        onChange={(e) => setSettings(s => ({ ...s, alarmDurationUnit: e.target.value as any }))}
                        className="bg-zinc-800 border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
                      >
                        <option value="seconds">Sec</option>
                        <option value="minutes">Min</option>
                      </select>
                    </div>
                  </div>

                  {/* Sound Selection */}
                  <div className="bg-zinc-900/50 p-6 rounded-3xl border border-zinc-800 space-y-4">
                    <div className="flex items-center space-x-3 mb-2">
                      <Volume2 className="w-5 h-5 text-zinc-400" />
                      <p className="font-bold">Alarm Sound</p>
                    </div>
                    
                    <div className="flex flex-col space-y-3">
                      <label className="flex items-center justify-center space-x-2 bg-zinc-800 hover:bg-zinc-700 transition-colors p-4 rounded-2xl cursor-pointer border border-dashed border-zinc-700">
                        <Play className="w-4 h-4" />
                        <span className="text-sm font-medium">Choose Custom File</span>
                        <input type="file" accept="audio/*" onChange={handleSoundUpload} className="hidden" />
                      </label>
                      
                      <button 
                        onClick={testAlarm}
                        className="flex items-center justify-center space-x-2 bg-emerald-500 hover:bg-emerald-600 text-zinc-950 p-4 rounded-2xl font-bold transition-colors"
                      >
                        <Volume2 className="w-4 h-4" />
                        <span>Test Alarm Sound</span>
                      </button>
                    </div>
                    
                    {settings.customSoundUrl && (
                      <div className="flex items-center space-x-2 text-xs text-emerald-500 bg-emerald-500/5 p-3 rounded-xl">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Custom sound loaded successfully</span>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Footer Navigation (Mobile Style) */}
        <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-zinc-950/80 backdrop-blur-xl border-t border-zinc-800 p-4 flex justify-around items-center z-30">
          <button 
            onClick={() => setActiveTab('home')}
            className={cn(
              "flex flex-col items-center space-y-1 transition-colors",
              activeTab === 'home' ? "text-emerald-500" : "text-zinc-500"
            )}
          >
            <Activity className="w-6 h-6" />
            <span className="text-[10px] font-bold uppercase">Monitor</span>
          </button>
          <button 
            onClick={() => setActiveTab('settings')}
            className={cn(
              "flex flex-col items-center space-y-1 transition-colors",
              activeTab === 'settings' ? "text-emerald-500" : "text-zinc-500"
            )}
          >
            <SettingsIcon className="w-6 h-6" />
            <span className="text-[10px] font-bold uppercase">Settings</span>
          </button>
        </nav>
      </div>
    </div>
  );
}
