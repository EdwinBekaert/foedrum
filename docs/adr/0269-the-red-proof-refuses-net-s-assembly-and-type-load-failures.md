# 0269. The red proof refuses .NET's assembly and type load failures

Date: 2026-10-30 · Status: Accepted · Amends [0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md) (four .NET load failures join the fixed list of load errors)

## Context
ADR 0078 fixes the list of texts that make a run a load, compile, import or collection error, which the red proof refuses.
For .NET it holds the compiler's `error CS<n>`, but none of the runtime's failures to load an assembly or a type.
The coverage spike of #618 hit one on Windows: app control blocked the test project's `Calc.dll`, and every test failed with `System.IO.FileLoadException : Could not load file or assembly '…\Calc.dll'. … (0x800711C7)`.
The red proof read that run as proven: every test the step added failed, none of them for the behaviour (#679).

A run of `dotnet test` (SDK 10.0.402, xunit 2.9.3) on this machine wrote these:

| Cause | Text |
| --- | --- |
| app control blocks the code's DLL | `System.IO.FileLoadException : Could not load file or assembly '…\Calc.dll'. Dit bestand is geblokkeerd door een beleid voor toepassingsbeheer. (0x800711C7)` |
| the DLL is missing, a native DLL or an x86 build | `System.IO.FileNotFoundException : Could not load file or assembly 'Calc, Version=2.0.0.0, Culture=neutral, PublicKeyToken=null'. Het systeem kan het opgegeven bestand niet vinden.` |
| `Assembly.LoadFrom` of a native DLL | `System.BadImageFormatException : Bad IL format. The format of the file '…\version.dll' is invalid.` |
| `Type.GetType` of a missing type | `System.TypeLoadException : Could not resolve type 'Calc.Missing' in assembly 'Calc.Tests, …'.` |
| a test that expects a `TypeLoadException` while the stub throws another exception | `Assert.Throws() Failure: Exception type was not an exact match` / `Expected: typeof(System.TypeLoadException)` |

The runtime's message after the type is localized, here partly in Dutch; the type's name is not.
App control blocked every rebuilt `Calc.dll`, so no `BadImageFormatException` or `TypeLoadException` raised by a reference could be made here: those two texts come from calls in a test, in the same `System.X : …` form.
The last row is a real red step, and it names a load failure's type.

## Decision
- Two texts join ADR 0078's list: `System.IO.FileLoadException`, `System.BadImageFormatException` or `System.TypeLoadException` followed by `:` (xunit writes ` : `, .NET's own text `: `), and `Could not load file or assembly`.
- The type is matched by its full name and the colon of an exception's text, never as a bare word: an assertion that expects the type (`typeof(System.TypeLoadException)`) and a test named after one stay red.
- A bare `FileNotFoundException` is not a load error: code under test throws it for a missing file. It counts only when the runtime's message says it could not load an assembly.

## Consequences
- A .NET run whose tests never loaded the code is refused, quoting the line, as other load errors are.
- A test that asserts on code which throws one of these still fails the red proof, as ADR 0078 says of every load error: a Gauger tests such an error by asserting on it.
- On a runtime that also localizes `Could not load file or assembly`, a `FileNotFoundException` of an assembly is not read; the `FileLoadException` of app control still is, by its type.
- Other runners' runtime load failures are not in the list yet; #618 owns the list as a whole.

## Alternatives considered
- **The bare type names (`\bTypeLoadException\b`):** they match `typeof(System.TypeLoadException)` in a failed `Assert.Throws`, a real red step.
- **Every `FileNotFoundException`:** it would refuse a stub that reads a missing file.
- **A test project with no report as the sign (#618's spike):** a run that loads nothing still writes a report with every test failed, so the text is needed anyway.
