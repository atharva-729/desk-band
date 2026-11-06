import sys, numpy as np, pandas as pd
from scipy.io import wavfile
from scipy.signal import butter, sosfilt
OFF=16.31
sr,x=wavfile.read(sys.argv[1]); x=x.astype(float)/32768
h=sosfilt(butter(4,300,'hp',fs=sr,output='sos'),x)
hop=40; env=np.array([np.abs(h[i:i+hop]).max() for i in range(0,len(h)-hop,hop)]); te=np.arange(len(env))*hop/sr-OFF
db=20*np.log10(env+1e-9)
wins=[(25.5,31.3),(36.5,42.5),(46.4,52.3),(54.5,60.3),(64.6,70.4),(74.8,80.6),(85.7,91.8),(94.7,100.6)]
labels=[3,1,4,2,2,4,1,3]
rows=[]
for k,((s,e),lab) in enumerate(zip(wins,labels)):
    m=np.where((te>=s)&(te<e))[0]; d=db[m]; floor=np.percentile(d,30)
    # greedy pick top peaks with min spacing 0.22s
    order=np.argsort(-d); chosen=[]
    for j in order:
        if d[j]<floor+12: break
        if all(abs(te[m[j]]-te[m[c]])>0.22 for c in chosen): chosen.append(j)
    ts=sorted(te[m[c]] for c in chosen)
    print(f"group {k+1} spot {lab}: {len(ts)} taps  {ts[0]:.2f}-{ts[-1]:.2f}  median gap {np.median(np.diff(ts)):.2f}")
    for tt in ts: rows.append((k+1,lab,1 if k<4 else 2,tt))
pd.DataFrame(rows,columns=["group","spot","pass","t_accel"]).to_csv(sys.argv[2],index=False)
