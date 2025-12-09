using System;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.VisualStudio.Shell;
using Task = System.Threading.Tasks.Task;

namespace Lucid.VisualStudioExtension
{
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [InstalledProductRegistration("Lucid", "Local Ollama chat inside Visual Studio", "1.0")]
    [ProvideToolWindow(typeof(LucidToolWindow))]
    [Guid(PackageGuidString)]
    public sealed class LucidVsPackage : AsyncPackage
    {
        public const string PackageGuidString = "d87f3a4c-98a7-4b58-8cda-6c95135406c2";

        internal static LucidVsPackage? Instance { get; private set; }

        protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            await base.InitializeAsync(cancellationToken, progress);
            Instance = this;

            // Create/show the tool window so the chat UI is immediately available.
            await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
            await ShowToolWindowAsync(typeof(LucidToolWindow), 0, true, cancellationToken);
        }
    }
}
