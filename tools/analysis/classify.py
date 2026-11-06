import sys, numpy as np, pandas as pd
from sklearn.model_selection import LeaveOneOut, cross_val_predict
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import confusion_matrix
df = pd.read_csv(sys.argv[1]); t=df.iloc[:,0].values; X3=df.iloc[:,1:4].values; a=df.iloc[:,4].values
# lower threshold detection
thr=0.13; peaks=[]; last=-1
for i in range(1,len(a)-1):
    if a[i]>thr and a[i]>=a[i-1] and a[i]>=a[i+1]:
        if last<0 or t[i]-t[last]>0.3: peaks.append(i); last=i
        elif a[i]>a[last]: peaks[-1]=i; last=i
pt=t[peaks]
# drop final pause press (>40s)
keep=[(p,tt) for p,tt in zip(peaks,pt) if tt<40]
peaks=[p for p,_ in keep]; pt=np.array([tt for _,tt in keep])
# group by gaps > 2.5s
g=np.concatenate([[0],np.cumsum(np.diff(pt)>2.5)])
print("taps per spot:", np.bincount(g), " times:", [ (round(pt[g==k][0],1),round(pt[g==k][-1],1)) for k in range(g.max()+1)])
feats=[]
for p in peaks:
    w=X3[p-2:p+6]            # 80 ms window
    e=np.sqrt((w**2).mean(0)) # rms per axis
    pk=w[np.argmax(np.abs(w),axis=0),range(3)] # signed peak per axis
    feats.append(np.concatenate([e/np.linalg.norm(e), pk/np.abs(pk).max(), [np.log(np.linalg.norm(e))]]))
F=np.array(feats); y=g
for name,clf in [("LDA",LinearDiscriminantAnalysis()),("LogReg",make_pipeline(StandardScaler(),LogisticRegression(max_iter=2000,C=1.0)))]:
    pred=cross_val_predict(clf,F,y,cv=LeaveOneOut())
    print(name,"leave-one-out accuracy: %.0f%% (chance %.0f%%)"%(100*(pred==y).mean(),100/len(set(y))))
    print(confusion_matrix(y,pred))
# per-spot mean signed z sign and xy direction
for k in range(g.max()+1):
    Fi=F[g==k]; print("spot",k+1,"mean rms xyz-dir",Fi[:,:3].mean(0).round(2),"mean loudness",np.exp(Fi[:,6]).mean().round(3))
