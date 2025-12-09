using Microsoft.VisualStudio.Shell;
using System;
using System.Runtime.InteropServices;
using System.Windows.Controls;

namespace Lucid.VisualStudioExtension
{
    [Guid("7c0d1b0c-3c58-4d1d-9a9a-5f787c3c1e9b")]
    public class LucidToolWindow : ToolWindowPane
    {
        public LucidToolWindow() : base(null)
        {
            Caption = "Lucid Chat";
            Content = new LucidToolWindowControl();
        }
    }
}
