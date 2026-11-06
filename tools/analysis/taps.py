import sys, numpy as np, pandas as pd
df = pd.read_csv(sys.argv[1])
t = df.iloc[:,0].values; x,y,z = df.iloc[:,1].values, df.iloc[:,2].values, df.iloc[:,3].values
a = df.iloc[:,4].values
dt = np.diff(t); print("rate Hz ~", 1/np.median(dt), "dur", t[-1])
print("noise median abs", np.median(a), "p95", np.percentile(a,95), "max", a.max())
# detect peaks
thr = np.median(a) + 6*np.median(np.abs(a-np.median(a)))*1.4826
print("thr", thr)
peaks=[]; last=-1
for i in range(1,len(a)-1):
    if a[i]>thr and a[i]>=a[i-1] and a[i]>=a[i+1]:
        if last<0 or t[i]-t[last]>0.25:
            peaks.append(i); last=i
        elif a[i]>a[last]:
            peaks[-1]=i; last=i
print("n peaks", len(peaks))
rows=[]
for i in peaks:
    w=slice(max(0,i-3),i+4)
    k=np.argmax(np.abs(z[w]))+w.start
    rows.append((t[i],a[i],x[i],y[i],z[i]))
r=pd.DataFrame(rows,columns=["t","amp","x","y","z"])
pd.set_option("display.width",200); print(r.round(3).to_string())
r.to_csv(sys.argv[2],index=False)
