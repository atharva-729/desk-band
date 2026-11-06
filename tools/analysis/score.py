import sys, numpy as np, pandas as pd
from scipy.io import wavfile
from scipy.signal import butter, sosfilt
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import confusion_matrix
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
OFF=16.31
taps=pd.read_csv(sys.argv[1])
sr,x=wavfile.read(sys.argv[2]); x=x.astype(float)/32768
h=sosfilt(butter(4,150,'hp',fs=sr,output='sos'),x)
acc=pd.read_csv(sys.argv[3]); at=acc.iloc[:,0].values; A=acc.iloc[:,1:4].values
# keep 15 loudest per group
def loud(tt):
    c=int((tt+OFF)*sr); return np.abs(h[c-320:c+320]).max()
taps["loud"]=taps.t_accel.apply(loud)
taps=taps.sort_values("loud",ascending=False).groupby("group").head(15).sort_values("t_accel").reset_index(drop=True)
print(taps.groupby(["pass","spot"]).size().unstack())
edges=np.geomspace(150,7900,19)
fa,fc=[],[]
for tt in taps.t_accel:
    c=int((tt+OFF)*sr); w=h[c-480:c+480]; c=c-480+np.argmax(np.abs(w))   # sharpen onset
    seg=h[c-80:c+1120]*np.hanning(1200)                                   # -5ms..+70ms
    S=np.abs(np.fft.rfft(seg,4096))**2; f=np.fft.rfftfreq(4096,1/sr)
    bands=np.array([S[(f>=lo)&(f<hi)].sum() for lo,hi in zip(edges[:-1],edges[1:])])
    lb=np.log(bands+1e-12); fa.append(np.r_[lb-lb.mean(), lb.mean()])
    i=np.argmin(np.abs(at-tt)); j=i-3+np.argmax(np.linalg.norm(A[i-3:i+4],axis=1)); win=A[j-2:j+7]
    rms=np.sqrt((win**2).mean(0)); pk=win[np.argmax(np.abs(win),0),range(3)]
    fc.append(np.r_[rms/np.linalg.norm(rms), pk/np.abs(pk).max(), np.log(np.linalg.norm(rms)), win.ravel()/np.abs(win).max()])
FA,FC=np.array(fa),np.array(fc); y=taps.spot.values; p=taps["pass"].values
sets={"accelerometer only":FC,"microphone only":FA,"both combined":np.c_[FA,FC]}
for name,F in sets.items():
    accs=[]; cms=np.zeros((4,4),int)
    for tr,te_ in [(1,2),(2,1)]:
        clf=make_pipeline(StandardScaler(),LogisticRegression(max_iter=5000,C=0.3))
        clf.fit(F[p==tr],y[p==tr]); pr=clf.predict(F[p==te_]); accs.append((pr==y[p==te_]).mean())
        cms+=confusion_matrix(y[p==te_],pr,labels=[1,2,3,4])
    print(f"\n{name}: train pass1->test pass2 {accs[0]:.0%}, train pass2->test pass1 {accs[1]:.0%}, avg {np.mean(accs):.0%} (chance 25%)")
    print(pd.DataFrame(cms,index=[f"true {i}" for i in range(1,5)],columns=[f"pred {i}" for i in range(1,5)]))
np.savez(sys.argv[4],FA=FA,FC=FC,y=y,p=p)
