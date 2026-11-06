import sys, numpy as np, pandas as pd
df=pd.read_csv(sys.argv[1]); t=df.iloc[:,0].values; a=df.iloc[:,4].values
ae=np.load(sys.argv[2]); at=ae[:,0]
thr=0.25; pk=[];last=-1
for i in range(1,len(a)-1):
    if a[i]>thr and a[i]>=a[i-1] and a[i]>=a[i+1]:
        if last<0 or t[i]-t[last]>0.3: pk.append(i); last=i
        elif a[i]>a[last]: pk[-1]=i; last=i
pt=t[pk]; print("accel events",len(pt))
res=[]
for off in np.arange(-5,20,0.01):
    d=np.min(np.abs(at[None,:]-(pt[:,None]+off)),axis=1)
    res.append(((d<0.06).sum(),off))
res.sort(reverse=True); print(res[:8])
