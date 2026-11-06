import sys, numpy as np
d=np.load(sys.argv[1]); FA,FC,y,p=d["FA"],d["FC"],d["y"],d["p"]
FC7=FC[:,:7]
rng=np.random.default_rng(0)
def run(F,ntrain,method,k=3):
    accs=[]
    for tr,te in [(1,2),(2,1)]:
        for rep in range(20):
            idx=np.concatenate([rng.choice(np.where((p==tr)&(y==c))[0],ntrain,replace=False) for c in [1,2,3,4]])
            X=F[idx]; Y=y[idx]; mu=X.mean(0); sd=X.std(0)+1e-6
            Z=(X-mu)/sd; T=(F[p==te]-mu)/sd; yt=y[p==te]
            if method=="centroid":
                C=np.array([Z[Y==c].mean(0) for c in [1,2,3,4]]); pr=np.array([1,2,3,4])[np.argmin(((T[:,None]-C[None])**2).sum(-1),1)]
            else:
                D=((T[:,None]-Z[None])**2).sum(-1); nn=np.argsort(D,1)[:,:k]; pr=np.array([np.bincount(Y[r],minlength=5).argmax() for r in nn])
            accs.append((pr==yt).mean())
    return np.mean(accs)
for name,F in [("mic",FA),("accel7",FC7),("mic+accel7",np.c_[FA,FC7])]:
    for n in [5,8,12]:
        print(f"{name:12s} n={n:2d} centroid {run(F,n,'centroid'):.0%}  3nn {run(F,n,'knn'):.0%}")
# plain multinomial logistic regression, same as I'd write in JS
def lr_fit(Z,Y,l2=0.3,it=600,lr=0.2):
    K=4; W=np.zeros((Z.shape[1],K)); b=np.zeros(K); Yo=np.eye(K)[Y-1]
    for _ in range(it):
        S=Z@W+b; S-=S.max(1,keepdims=True); P=np.exp(S); P/=P.sum(1,keepdims=True)
        G=(P-Yo)/len(Z); W-=lr*(Z.T@G+l2*W/len(Z)*len(Z)/len(Z)); b-=lr*G.sum(0)
    return W,b
def run_lr(F,ntrain,l2):
    accs=[]
    for tr,te in [(1,2),(2,1)]:
        for rep in range(20):
            idx=np.concatenate([rng.choice(np.where((p==tr)&(y==c))[0],ntrain,replace=False) for c in [1,2,3,4]])
            X=F[idx]; Y=y[idx]; mu=X.mean(0); sd=X.std(0)+1e-6
            W,b=lr_fit((X-mu)/sd,Y,l2); pr=np.argmax(((F[p==te]-mu)/sd)@W+b,1)+1
            accs.append((pr==y[p==te]).mean())
    return np.mean(accs)
for l2 in [0.01,0.05,0.2]:
    print("LR mic+accel7 l2",l2,[f"n={n}:{run_lr(np.c_[FA,FC7],n,l2):.0%}" for n in [5,8,12]])
