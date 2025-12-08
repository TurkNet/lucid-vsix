using System;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;

namespace Lucid.VisualStudioExtension
{
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [InstalledProductRegistration("Lucid", "Lucid Visual Studio extension (stub)", "1.0")]
    [Guid("00000000-0000-0000-0000-000000000000")]
    public sealed class LucidVsPackage : AsyncPackage
    {
        protected override async System.Threading.Tasks.Task InitializeAsync(System.Threading.CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            await base.InitializeAsync(cancellationToken, progress);
            // Initialization logic for the Visual Studio package can go here.
        }
    }
}
