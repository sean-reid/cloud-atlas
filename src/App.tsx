import { Link, Route, Switch } from "wouter";
import { Layout } from "./components/Layout";
import { ApiDocs } from "./pages/ApiDocs";
import { Availability } from "./pages/Availability";
import { EntityDetail } from "./pages/EntityDetail";
import { Methodology } from "./pages/Methodology";
import { Overview } from "./pages/Overview";
import { ProviderDetail } from "./pages/ProviderDetail";
import { Sites } from "./pages/Sites";
import { Sources } from "./pages/Sources";

export function App() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/sites" component={Sites} />
        <Route path="/sites/:id" component={EntityDetail} />
        <Route path="/providers/:slug" component={ProviderDetail} />
        <Route path="/availability" component={Availability} />
        <Route path="/methodology" component={Methodology} />
        <Route path="/sources" component={Sources} />
        <Route path="/api" component={ApiDocs} />
        <Route>
          <section className="block">
            <h1>Not found</h1>
            <p className="muted">
              That page does not exist. <Link href="/">Back to the overview</Link>
            </p>
          </section>
        </Route>
      </Switch>
    </Layout>
  );
}
