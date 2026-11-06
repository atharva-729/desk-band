import sys, numpy as np, pandas as pd, matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from scipy.io import wavfile
from scipy.signal import butter, sosfilt
OFF=float(sys.argv[4]) if len(sys.argv)>4 else 8.94
df=pd.read_csv(sys.argv[1]); t=df.iloc[:,0].values; a=df.iloc[:,4].values
sr,x=wavfile.read(sys.argv[2]); x=x.astype(float)/32768
h=sosfilt(butter(4,300,'hp',fs=sr,output='sos'),x)
hop=40; env=np.array([np.abs(h[i:i+hop]).max() for i in range(0,len(h)-hop,hop)]); te=np.arange(len(env))*hop/sr-OFF
segs=[(0,100)]
fig,axs=plt.subplots(6,1,figsize=(18,16))
for k,(s,e) in enumerate([(0,18),(18,36),(36,54),(54,72),(72,90),(90,105)]):
    ax=axs[k]; m=(te>=s)&(te<e); ax.plot(te[m],20*np.log10(env[m]+1e-6),lw=.5,color='tab:blue'); ax.set_ylim(-80,0)
    ax2=ax.twinx(); mm=(t>=s)&(t<e); ax2.plot(t[mm],a[mm],color='tab:red',lw=.8); ax2.set_ylim(0,1.2)
    ax.set_xlim(s,e); ax.set_xticks(np.arange(s,e+1,1)); ax.grid(alpha=.3)
plt.tight_layout(); plt.savefig(sys.argv[3],dpi=70)
