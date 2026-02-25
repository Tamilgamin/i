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
  Activity,
  TrendingUp,
  TrendingDown,
  Minus,
  History,
  Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Haptics } from '@capacitor/haptics';
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  Tooltip, 
  CartesianGrid 
} from 'recharts';

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
  relayState: 'incubator/relaystate',
  relayControl: 'incubator/relaycon',
};

// Types
type Status = 'LOW' | 'NORMAL' | 'HIGH' | 'DISCONNECTED';

interface HistoryPoint {
  time: string;
  value: number;
  timestamp: number;
}

interface AppSettings {
  alarmEnabled: boolean;
  alarmDuration: number; // in seconds
  alarmDurationUnit: 'seconds' | 'minutes';
  customSoundUrl: string | null;
  lowTempThreshold: number;
  highTempThreshold: number;
  vibrateEnabled: boolean;
}

// Native notification
async function notify(title: string, body: string) {
  if (!Capacitor.isNativePlatform()) {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body, icon: "/favicon.ico" });
    }
    return;
  }
  
  await LocalNotifications.schedule({
    notifications: [
      { 
        title, 
        body, 
        id: 1, // Use fixed ID for the alarm to overwrite previous ones
        sound: 'alarm.wav', 
        actionTypeId: 'ALARM_ACTIONS',
        extra: { type: 'alarm' }
      }
    ],
  });
}

export default function App() {
  // State
  const [temp, setTemp] = useState<number | null>(null);
  const [prevTemp, setPrevTemp] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>('DISCONNECTED');
  const [relayState, setRelayState] = useState<'ON' | 'OFF'>('OFF');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [activeTab, setActiveTab] = useState<'home' | 'settings' | 'history'>('home');
  const [history, setHistory] = useState<HistoryPoint[]>(() => {
    const saved = localStorage.getItem('incubator_history');
    return saved ? JSON.parse(saved) : [];
  });

  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('incubator_settings');
    const defaults: AppSettings = {
      alarmEnabled: true,
      alarmDuration: 30,
      alarmDurationUnit: 'seconds',
      customSoundUrl: null,
      lowTempThreshold: 25,
      highTempThreshold: 65,
      vibrateEnabled: true,
    };
    if (saved) {
      try {
        return { ...defaults, ...JSON.parse(saved), customSoundUrl: null };
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

  useEffect(() => {
    localStorage.setItem('incubator_history', JSON.stringify(history.slice(-100))); 
  }, [history]);
  
  // Refs
  const mqttClient = useRef<mqtt.MqttClient | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const alarmTimerRef = useRef<NodeJS.Timeout | null>(null);
  const vibrationIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // 🔔 Alarm Control
  const stopAlarm = useCallback(() => {
    setIsAlarmActive(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (alarmTimerRef.current) {
      clearTimeout(alarmTimerRef.current);
    }
    if (vibrationIntervalRef.current) {
      clearInterval(vibrationIntervalRef.current);
    }
  }, []);

  // 🔔 Notification Actions & Foreground Service
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      LocalNotifications.requestPermissions();
      
      LocalNotifications.registerActionTypes({
        types: [
          {
            id: 'ALARM_ACTIONS',
            actions: [
              { id: 'mute', title: 'Mute Alarm', foreground: true }
            ]
          }
        ]
      });

      const actionListenerPromise = LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
        if (action.actionId === 'mute') {
          stopAlarm();
        }
      });

      return () => {
        actionListenerPromise.then(h => h.remove());
      };
    } else if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, [stopAlarm]);

  // 🚀 Foreground service (keeps app alive)
  useEffect(() => {
    if (Capacitor.getPlatform() === "android") {
      // @ts-ignore
      const fgService = window.cordova?.plugins?.foregroundService || window.Capacitor?.Plugins?.ForegroundService;
      if (fgService) {
        fgService.start("Incubator Monitor", "Monitoring temperature in background", "notification_icon", 1);
      }
    }
  }, []);

  // MQTT Connection Logic
  useEffect(() => {
    const client = mqtt.connect(`wss://${MQTT_CONFIG.host}:${MQTT_CONFIG.port}/mqtt`, {
      username: MQTT_CONFIG.username,
      password: MQTT_CONFIG.password,
      clientId: `incubator_${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      connectTimeout: 30000,
      reconnectPeriod: 5000,
      keepalive: 60,
      reschedulePings: true,
    });

    client.on('connect', () => {
      setIsConnected(true);
      setIsReconnecting(false);
      setErrorMsg(null);
      client.subscribe([TOPICS.temp, TOPICS.relayState]);
    });

    client.on('error', (err) => {
      if (err.message !== 'client disconnecting') {
        setErrorMsg(err.message);
      }
      setIsConnected(false);
    });

    client.on('reconnect', () => {
      setIsReconnecting(true);
      setIsConnected(false);
    });

    client.on('message', (topic, message) => {
      const payload = message.toString();
      if (topic === TOPICS.temp) {
        const newTemp = parseFloat(payload);
        if (isNaN(newTemp)) return;

        setTemp(current => {
          setPrevTemp(current);
          return newTemp;
        });
        
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        setHistory(prev => [...prev, { time: timeStr, value: newTemp, timestamp: Date.now() }].slice(-100));

        if (newTemp < settings.lowTempThreshold) setStatus('LOW');
        else if (newTemp > settings.highTempThreshold) setStatus('HIGH');
        else setStatus('NORMAL');
      }

      if (topic === TOPICS.relayState) {
        setRelayState(payload.toUpperCase() === 'ON' ? 'ON' : 'OFF');
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
  }, [settings.lowTempThreshold, settings.highTempThreshold]);

  const triggerAlarm = useCallback(async () => {
    if (!settings.alarmEnabled || isAlarmActive) return;

    setIsAlarmActive(true);
    
    if (audioRef.current) {
      audioRef.current.play().catch(e => console.error("Audio playback failed", e));
    }

    if (settings.vibrateEnabled) {
      const vibrate = async () => {
        if (Capacitor.isNativePlatform()) {
          await Haptics.vibrate({ duration: 1000 });
        }
      };
      vibrate();
      vibrationIntervalRef.current = setInterval(vibrate, 2000);
    }

    await notify("🚨 Incubator Alert!", `Temperature is ${temp}°C (${status}). Check the incubator immediately.`);

    const durationMs = settings.alarmDurationUnit === 'minutes' 
      ? settings.alarmDuration * 60 * 1000 
      : settings.alarmDuration * 1000;
    
    alarmTimerRef.current = setTimeout(stopAlarm, durationMs);
  }, [settings, isAlarmActive, temp, status, stopAlarm]);

  useEffect(() => {
    if (temp !== null) {
      if (temp < settings.lowTempThreshold || temp > settings.highTempThreshold) {
        triggerAlarm();
      }
    }
  }, [temp, triggerAlarm, settings.lowTempThreshold, settings.highTempThreshold]);

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
    if (Capacitor.isNativePlatform()) {
      Haptics.vibrate({ duration: 500 });
    }
  };

  const toggleRelay = () => {
    if (!mqttClient.current?.connected) return;
    const newState = relayState === "ON" ? "OFF" : "ON";
    mqttClient.current.publish(TOPICS.relayControl, newState);
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem('incubator_history');
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      <audio 
        ref={audioRef} 
        src={settings.customSoundUrl || 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3'} 
        loop 
      />

      <div className="max-w-md mx-auto min-h-screen flex flex-col relative overflow-hidden">
        
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
                <div className="relative flex flex-col items-center py-12">
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
                              <TrendingUp className="w-3 h-3" />
                            </motion.div>
                          ) : (
                            <motion.div animate={{ y: [0, 4, 0] }} transition={{ repeat: Infinity }} className="text-blue-400 flex items-center">
                              <span className="text-[10px] font-bold mr-1">FALLING</span>
                              <TrendingDown className="w-3 h-3" />
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
                </div>

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

                <div className="bg-zinc-900/50 border border-zinc-800 p-6 rounded-3xl backdrop-blur-md flex items-center justify-between">
                  <div className="flex items-center space-x-4">
                    <div className={cn(
                      "p-3 rounded-2xl transition-colors duration-500",
                      relayState === 'ON' ? "bg-emerald-500/20" : "bg-zinc-800"
                    )}>
                      <Activity className={cn("w-6 h-6", relayState === "ON" ? "text-emerald-500" : "text-zinc-600")} />
                    </div>
                    <div>
                      <p className="font-bold text-zinc-200">Relay Status</p>
                      <p className="text-xs text-zinc-500">Manual Control</p>
                    </div>
                  </div>
                  <button 
                    onClick={toggleRelay}
                    disabled={!isConnected}
                    className={cn(
                      "w-14 h-8 rounded-full relative transition-all duration-500 disabled:opacity-30",
                      relayState === "ON" ? "bg-emerald-500" : "bg-zinc-800"
                    )}
                  >
                    <motion.div 
                      animate={{ x: relayState === "ON" ? 24 : 0 }}
                      className="absolute top-1 left-1 w-6 h-6 bg-white rounded-full shadow-lg" 
                    />
                  </button>
                </div>

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
            ) : activeTab === 'history' ? (
              <motion.div 
                key="history"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-6"
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-bold">Temperature History</h2>
                  <button 
                    onClick={clearHistory}
                    className="p-2 text-zinc-500 hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>

                <div className="bg-zinc-900/50 border border-zinc-800 p-4 rounded-3xl h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={history}>
                      <defs>
                        <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                      <XAxis 
                        dataKey="time" 
                        stroke="#71717a" 
                        fontSize={10} 
                        tickLine={false} 
                        axisLine={false}
                        interval="preserveStartEnd"
                      />
                      <YAxis 
                        stroke="#71717a" 
                        fontSize={10} 
                        tickLine={false} 
                        axisLine={false}
                        domain={['auto', 'auto']}
                      />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '12px' }}
                        itemStyle={{ color: '#10b981' }}
                      />
                      <Area 
                        type="monotone" 
                        dataKey="value" 
                        stroke="#10b981" 
                        fillOpacity={1} 
                        fill="url(#colorValue)" 
                        strokeWidth={2}
                        animationDuration={1000}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                <div className="space-y-2">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest px-2">Recent Readings</p>
                  <div className="space-y-1 max-h-64 overflow-y-auto pr-2 custom-scrollbar">
                    {history.slice().reverse().map((point, i) => (
                      <div key={point.timestamp} className="flex items-center justify-between bg-zinc-900/30 p-3 rounded-2xl border border-zinc-800/50">
                        <span className="text-xs text-zinc-500">{point.time}</span>
                        <span className="font-mono font-bold">{point.value.toFixed(1)}°C</span>
                      </div>
                    ))}
                  </div>
                </div>
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

                  <div className="flex items-center justify-between bg-zinc-900/50 p-6 rounded-3xl border border-zinc-800">
                    <div className="flex items-center space-x-4">
                      <div className={cn("p-3 rounded-2xl", settings.vibrateEnabled ? "bg-emerald-500/10" : "bg-zinc-800")}>
                        <Activity className={cn("w-6 h-6", settings.vibrateEnabled ? "text-emerald-500" : "text-zinc-500")} />
                      </div>
                      <div>
                        <p className="font-bold">Vibration</p>
                        <p className="text-xs text-zinc-500">Vibrate during alarm</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => setSettings(s => ({ ...s, vibrateEnabled: !s.vibrateEnabled }))}
                      className={cn(
                        "w-14 h-8 rounded-full relative transition-colors duration-300",
                        settings.vibrateEnabled ? "bg-emerald-500" : "bg-zinc-700"
                      )}
                    >
                      <div className={cn(
                        "absolute top-1 w-6 h-6 bg-white rounded-full transition-all duration-300 shadow-sm",
                        settings.vibrateEnabled ? "left-7" : "left-1"
                      )} />
                    </button>
                  </div>

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
                        <span>Test Alarm & Vibrate</span>
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
            onClick={() => setActiveTab('history')}
            className={cn(
              "flex flex-col items-center space-y-1 transition-colors",
              activeTab === 'history' ? "text-emerald-500" : "text-zinc-500"
            )}
          >
            <History className="w-6 h-6" />
            <span className="text-[10px] font-bold uppercase">History</span>
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
