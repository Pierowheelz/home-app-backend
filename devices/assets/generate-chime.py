"""Generate devices/assets/doorbell-chime.wav (double ding-dong). Usage: python3 generate-chime.py <out.wav> [--measure-only]"""
import math, struct, sys, wave

def measure(path):
    with wave.open(path) as w:
        n, ch = w.getnframes(), w.getnchannels()
        data = struct.unpack('<%dh' % (n * ch), w.readframes(n))
    mono = [data[i] / 32768 for i in range(0, len(data), ch)]
    peak = max(abs(x) for x in mono)
    rms = math.sqrt(sum(x * x for x in mono) / len(mono))
    # loudest 400 ms window (closer to how loud it sounds)
    win = int(0.4 * 44100); best = 0
    acc = sum(x * x for x in mono[:win])
    for i in range(win, len(mono)):
        acc += mono[i] ** 2 - mono[i - win] ** 2
        best = max(best, acc)
    db = lambda v: 20 * math.log10(max(v, 1e-9))
    return 'peak %.1f dBFS | RMS %.1f dBFS | loudest 400ms RMS %.1f dBFS | %.2fs' % (db(peak), db(rms), db(math.sqrt(best / win)), len(mono) / 44100)

if '--measure-only' in sys.argv:
    print(measure(sys.argv[1])); sys.exit()

RATE = 44100
LENGTH_S = 4.6
NOTES = [(0.0, 659.25), (0.7, 523.25), (1.8, 659.25), (2.5, 523.25)]  # ding-dong, ding-dong (E5, C5)
HARMONICS = [(1.0, 1.0), (2.0, 0.5), (3.0, 0.3), (4.0, 0.15), (5.0, 0.08)]
DECAY = 1.1                                                  # slower fade than before (2.2)
DRIVE = 2.5                                                  # tanh soft clip: raises average level

n = int(RATE * LENGTH_S)
buf = [0.0] * n
for start, f in NOTES:
    s0 = int(start * RATE)
    for i in range(s0, n):
        t = (i - s0) / RATE
        env = min(1.0, t / 0.004) * math.exp(-t * DECAY)
        buf[i] += env * sum(a * math.sin(2 * math.pi * f * m * t) * math.exp(-t * m * 0.5) for m, a in HARMONICS)
peak = max(abs(x) for x in buf)
buf = [math.tanh(DRIVE * x / peak) for x in buf]
fade = int(0.3 * RATE)
for i in range(n - fade, n):
    buf[i] *= (n - i) / fade
gain = (10 ** (-0.5 / 20)) / max(abs(x) for x in buf)       # -0.5 dBFS peak
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(RATE)
    w.writeframes(b''.join(struct.pack('<hh', v, v) for v in (int(x * gain * 32767) for x in buf)))
print(measure(sys.argv[1]))
