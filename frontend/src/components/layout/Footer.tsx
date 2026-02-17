export default function Footer() {
  return (
    <footer className="nlr-footer mt-auto">
      {/* Footer Top */}
      <div className="nlr-footer-top">
        <div className="max-w-5xl mx-auto px-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center">
            <div>
              <a href="https://www.nlr.gov" className="font-bold">
                National Laboratory of the Rockies
              </a>
            </div>
            <div className="flex flex-wrap gap-4 mt-2 md:mt-0 text-sm">
              <a href="https://www.nlr.gov/about/">About</a>
              <a href="https://www.nlr.gov/research/">Research</a>
              <a href="https://www.nlr.gov/workingwithus/">Work with Us</a>
              <a href="https://www.nlr.gov/news/">News</a>
            </div>
          </div>
        </div>
      </div>

      {/* Footer Bottom */}
      <div className="nlr-footer-bottom">
        <div className="max-w-5xl mx-auto px-4">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <div className="flex items-center gap-6 mb-4 md:mb-0">
              <a
                href="https://www.allianceforsustainableenergy.org/"
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  src="/images/alliance-logo_black.svg"
                  alt="Alliance for Energy Innovation"
                  className="h-8"
                />
              </a>
              <a
                href="https://www.energy.gov"
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  src="/images/doe-logo.svg"
                  alt="U.S. Department of Energy"
                  className="h-10"
                />
              </a>
            </div>
            <p className="nlr-attr text-center md:text-right max-w-md flex-grow">
              The National Laboratory of the Rockies is a national laboratory of the
              U.S. Department of Energy, Office of Critical Minerals and Energy Innovation.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
