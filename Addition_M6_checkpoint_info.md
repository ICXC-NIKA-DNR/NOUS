This is actually an excellent opportunity to establish one of the core philosophies of your calculator. I wouldn't ask Claude Code to "fix the bug." I'd ask it to **redesign the graph analysis architecture** so that these bugs cannot occur in the first place.

Here's the prompt I'd give Claude Code.

---

# **Prompt**

You are working on the graphing engine of a mathematical computing platform whose goal is to eventually surpass traditional graphing calculators such as Desmos, GeoGebra, and TI-Nspire in mathematical correctness, extensibility, and symbolic understanding.

## **Background**

The current graphing engine has several architectural flaws.

### **Problem 1: Duplicate graphs produce false intersection points.**

When plotting

```
y = x
```

and

```
y = x
```

the engine generates hundreds or thousands of highlighted "special points" along the entire line.

These appear to be treated as intersections.

This behavior is mathematically incorrect.

The engine should recognize that these are **identical functions**, not intersecting functions.

The expected behavior is something like:

* no intersection markers  
* or a message indicating the functions are identical  
* or a representation of infinitely many shared points

Under no circumstances should every sampled point become an intersection.

---

### **Problem 2: Exact points are labeled as approximations.**

For example,

```
y = x

y = -x
```

should intersect exactly at

```
(0,0)
```

However the UI instead displays

```
≈ (0,0)
```

or

```
≈ (-0.0000001, 0.00000002)
```

This indicates that the graph engine is determining intersections from numerical sampling rather than mathematical reasoning.

Whenever a point is mathematically exact, it should be displayed exactly.

Approximation symbols should only be used when an exact symbolic solution cannot be obtained.

---

### **Problem 3: Graph rendering appears tightly coupled with mathematical analysis.**

Currently it seems the application is:

1. sampling graph points  
2. drawing them  
3. inspecting sampled pixels or nearby sampled coordinates  
4. declaring interesting points

This causes numerous problems including:

* duplicate intersections  
* missed intersections  
* approximate exact answers  
* instability at different zoom levels  
* numerical artifacts

The graph should never be the source of mathematical truth.

The graph is only a visualization.

The mathematics should determine what exists.

The renderer should only display it.

---

# **Goal**

I want the graphing subsystem redesigned around professional mathematical software architecture.

Please analyze the existing implementation and determine where responsibilities are mixed together.

Specifically determine whether rendering, symbolic reasoning, numerical solving, and graph analysis are currently coupled.

---

# **Desired Architecture**

I want the graph engine divided into independent layers.

## **1\. Symbolic Analysis Layer**

Responsible for understanding mathematical expressions.

Examples:

```
y = x

y = x
```

should immediately determine

```
f(x) == g(x)
```

and classify them as identical.

Likewise

```
y = x

y = 2x
```

should symbolically solve

```
x = 2x
```

to obtain

```
x = 0
```

before any rendering occurs.

Whenever symbolic simplification or solving is possible, it should be preferred over numerical methods.

---

## **2\. Numerical Solver Layer**

Only when symbolic solving fails should numerical methods be used.

Possible methods include

* Newton-Raphson  
* Brent's Method  
* Interval Bisection  
* Adaptive subdivision

Numerical methods should explicitly indicate that results are approximations.

For example

```
≈ (0.876512, 0.768112)
```

rather than pretending they are exact.

---

## **3\. Graph Analysis Layer**

This layer determines mathematical features such as

* intersections  
* roots  
* extrema  
* discontinuities  
* asymptotes  
* tangent points  
* cusps  
* undefined regions

This layer should never inspect rendered pixels.

Instead it should analyze mathematical functions.

---

## **4\. Rendering Layer**

Rendering should be completely independent.

Its only responsibilities should be

* adaptive sampling  
* curve tessellation  
* viewport clipping  
* antialiasing  
* GPU drawing

Rendering should never decide whether an intersection exists.

Rendering should never create mathematical objects.

Rendering simply visualizes results already computed.

---

# **Adaptive Sampling**

Please inspect whether graph sampling is currently uniform.

If so, redesign it using adaptive subdivision similar to professional graphing software.

Curves should receive more samples in regions of

* high curvature  
* discontinuities  
* asymptotes  
* oscillations

and fewer samples on nearly linear regions.

Rendering quality should not depend on arbitrary fixed step sizes.

---

# **Exact vs Approximate Mathematics**

Introduce a distinction throughout the graph engine between

```
ExactValue
```

and

```
ApproximateValue
```

Every computed mathematical object should know whether it is

* exact  
* symbolic  
* numerical approximation

Examples:

```
0
```

should remain

```
0
```

not

```
≈ 0
```

Likewise

```
sqrt(2)
```

should remain symbolic whenever possible rather than immediately becoming

```
1.41421356...
```

---

# **Coincident Functions**

The engine should distinguish between

```
no solutions

one solution

finite solutions

infinitely many solutions
```

For example

```
y=x

y=x
```

should produce

```
InfiniteIntersectionSet
```

rather than thousands of point objects.

---

# **Internal Data Model**

Consider introducing distinct internal types such as

```
GraphObject

FunctionDefinition

Intersection

CoincidentGraphs

ExactPoint

ApproximatePoint

CriticalPoint

Root

Asymptote

Feature
```

rather than representing everything as sampled coordinates.

---

# **UI Expectations**

The UI should simply render mathematical objects.

Examples:

Exact point:

```
(0,0)
```

Approximate point:

```
≈ (1.203948, -0.447311)
```

Coincident graphs:

```
Infinite intersections
Graphs are identical
```

No duplicate markers should ever appear.

---

# **Deliverables**

Please:

1. Inspect the existing graph architecture.  
2. Explain why these bugs occur.  
3. Identify every architectural issue that contributes to them.  
4. Refactor the code so rendering and mathematics are fully separated.  
5. Preserve existing functionality where possible.  
6. Add comments explaining the new architecture.  
7. If necessary, redesign portions of the graph engine rather than applying superficial fixes.  
8. Ensure the architecture is extensible for future features including symbolic calculus, differential equations, implicit graphing, parametric graphing, 3D graphing, and exact arithmetic.

---

## **Guiding Principle**

The graph is **not** the mathematics.

The graph is merely a visualization of mathematical objects computed by the symbolic and numerical engines.

Mathematical truth should never depend on pixels, sampled points, screen resolution, or zoom level.

The resulting architecture should resemble the design philosophy of professional mathematical software rather than a traditional pixel-based graph plotter.

It should be dependable but be a supplement to the overall CAS portion of the gcalc

